let app;
let initError;

try {
    const mod = await import('../server/server.js');
    app = mod.default;
} catch (err) {
    initError = err;
}

export default function handler(req, res) {
    if (initError) {
        res.status(500).json({
            error: 'Server initialization failed',
            message: initError.message,
            stack: initError.stack,
        });
        return;
    }
    return app(req, res);
}
