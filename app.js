// Import necessary libraries
import express from 'express'; // Web framework for building the API
import fetch from 'node-fetch'; // Allows making HTTP requests
import * as cheerio from 'cheerio'; // Helps parse and extract HTML content
import tough from 'tough-cookie'; // Manages cookies for login sessions
import fetchCookie from 'fetch-cookie'; // Wraps fetch to support cookie jar

// Initialize Express app
const app = express();
const PORT = 3000;

// Base URL for scraping (the target website)
const BASE_URL = 'https://user.orangecommunication.org';

// Define a GET endpoint at /
app.get('/', async (req, res) => {
    // Get username and password from the URL query parameters
    const { username, password } = req.query;

    // If either is missing, return an error
    if (!username || !password) {
        return res.status(400).json({
            success: false,
            error: 'Missing "username" or "password" query parameters.'
        });
    }

    try {
        // Try to fetch data using the login credentials
        const data = await fetchAllUserData(username, password);
        res.json(data); // Return the scraped data
    } catch (err) {
        // Handle any errors during the process
        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

// Function to fetch and scrape all user-related data
async function fetchAllUserData(username, password) {
    // Create a cookie jar to maintain session cookies
    const cookieJar = new tough.CookieJar();
    const fetchWithCookies = fetchCookie(fetch, cookieJar);

    // Common HTTP headers to mimic a browser
    const headers = {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
    };

    // Step 1: Load the login page to get CSRF token
    const loginPageRes = await fetchWithCookies(`${BASE_URL}/customer/`, { headers });
    if (!loginPageRes.ok) throw new Error(`Failed to load login page: ${loginPageRes.status}`);

    const loginPageHtml = await loginPageRes.text();
    const $loginPage = cheerio.load(loginPageHtml);

    // Extract CSRF token from login page form
    const csrfToken = $loginPage('input[name="_csrf"]').val();

    // Step 2: Prepare and send login form
    const loginForm = new URLSearchParams();
    loginForm.append('USERNAME', username);
    loginForm.append('PASS', password);
    if (csrfToken) loginForm.append('_csrf', csrfToken);

    const loginRes = await fetchWithCookies(`${BASE_URL}/customer/login`, {
        method: 'POST',
        headers: {
            ...headers,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Origin': BASE_URL,
            'Referer': `${BASE_URL}/customer/`,
        },
        body: loginForm,
        redirect: 'follow',
    });

    // Check if login was successful by checking redirected URL
    const finalUrl = loginRes.url;
    if (!finalUrl.endsWith('/dashboard')) {
        throw new Error(`Login failed. Final URL: ${finalUrl}`);
    }

    // Step 3: Parse dashboard HTML to extract user info
    const dashboardHtml = await loginRes.text();
    const $d = cheerio.load(dashboardHtml);

    // Helper function to extract text next to specific icons/tooltips
    const extractTextByTitle = (title) => {
        const icon = $d(`i[data-toggle="tooltip"][title="${title}"]`);
        const parentFlex = icon.closest('.d-flex');
        if (parentFlex.length === 0) return 'N/A';

        // Different titles need slightly different parsing
        if (title === 'Account Status') return parentFlex.find('font').text().trim();
        if (title === 'Connection Status') return parentFlex.find('span.bg-success').text().trim();
        if (title === 'Expiry Date') return parentFlex.find('span.text-success font').text().trim();
        if (title === 'Plan rate') return parentFlex.find('span').text().replace(/\s\s+/g, ' ').trim();

        return parentFlex.clone().children().remove().end().text().trim();
    };

    // Build user information object
    const userInfo = {
        name: extractTextByTitle('Name'),
        id: extractTextByTitle('ID'),
        username: extractTextByTitle('Username'),
        mobile: extractTextByTitle('Mobile'),
        accountStatus: extractTextByTitle('Account Status'),
        connectionStatus: extractTextByTitle('Connection Status'),
        expiryDate: extractTextByTitle('Expiry Date'),
        package: extractTextByTitle('Package'),
        planRate: extractTextByTitle('Plan rate'),
    };

    // Step 4: Extract payment history table
    const paymentHistory = [];
    $d('#paymentH tbody tr').each((_, row) => {
        const cells = $d(row).find('td');
        paymentHistory.push({
            payDate: $d(cells[0]).text().trim(),
            billAmount: $d(cells[1]).text().trim(),
            receivedAmount: $d(cells[2]).text().trim(),
            remarks: $d(cells[3]).text().trim().replace(/\s+/g, ' ')
        });
    });

    // Step 5: Fetch usage logs (another page)
    const usageRes = await fetchWithCookies(`${BASE_URL}/customer/syslog`, {
        headers: { ...headers }
    });
    if (!usageRes.ok) throw new Error(`Failed to load usage page: ${usageRes.status}`);

    const usageHtml = await usageRes.text();
    const $u = cheerio.load(usageHtml);

    // Step 6: Parse session usage history
    const usageHistory = [];
    $u('#sessionL tbody tr').each((_, row) => {
        const cells = $u(row).find('td');
        usageHistory.push({
            connectionDate: $u(cells[0]).text().trim(),
            disconnectionDate: $u(cells[1]).text().trim(),
            upload: $u(cells[2]).text().trim(),
            download: $u(cells[3]).text().trim(),
            sessionTime: $u(cells[4]).text().trim()
        });
    });

    // Return all collected data
    return {
        success: true,
        data: {
            userInfo,
            paymentHistory,
            usageHistory
        },
        error: null
    };
}

// Start the Express server
app.listen(PORT, () => {
    console.log(`✅ Server running at http://localhost:${PORT}`);
});
