const PUBLIC_API_ROUTES = new Set([
  '/api/market-data',
  '/api/status',
  '/api/fyers/login',
  '/api/fyers/auth/callback'
]);

export function requiresFyersSession(pathname) {
  return typeof pathname === 'string' &&
    pathname.startsWith('/api/') &&
    !PUBLIC_API_ROUTES.has(pathname);
}
