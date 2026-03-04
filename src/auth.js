// src/auth.js

const API_BASE = 'http://localhost:3001';

/**
 * Register a new user
 */
export async function register(name, email, password) {
    try {
        const response = await fetch(`${API_BASE}/api/auth/register`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ name, email, password })
        });

        const data = await response.json();
        return { success: response.ok, ...data };
    } catch (error) {
        console.error('Registration error:', error);
        return { success: false, error: 'Registration failed due to network error' };
    }
}

/**
 * Login a user and store session
 */
export async function login(email, password) {
    try {
        const response = await fetch(`${API_BASE}/api/auth/login`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ email, password })
        });

        const data = await response.json();

        if (response.ok && data.user) {
            // Store session
            localStorage.setItem('orbit_session', JSON.stringify({
                user: data.user,
                timestamp: Date.now()
            }));
            return true;
        }
        return false;
    } catch (error) {
        console.error('Login error:', error);
        return false;
    }
}

/**
 * Main dashboard auth protection
 * Call this at the top of main.js
 */
export function enforceAuth() {
    const sessionStr = localStorage.getItem('orbit_session');

    if (!sessionStr) {
        window.location.href = '/login.html';
        return null;
    }

    try {
        const session = JSON.parse(sessionStr);
        // Optional: Expire session after 24 hours
        if (Date.now() - session.timestamp > 24 * 60 * 60 * 1000) {
            localStorage.removeItem('orbit_session');
            window.location.href = '/login.html';
            return null;
        }
        return session.user;
    } catch (e) {
        localStorage.removeItem('orbit_session');
        window.location.href = '/login.html';
        return null;
    }
}

/**
 * Log out user
 */
export function logout() {
    localStorage.removeItem('orbit_session');
    window.location.href = '/login.html';
}
