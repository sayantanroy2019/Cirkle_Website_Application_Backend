export default function errorHandler(err, req, res, next) {
    console.error(`[ERROR] ${req.method} ${req.path}`, err);
    res.status(500).json({ error: 'Internal server error' });
}
