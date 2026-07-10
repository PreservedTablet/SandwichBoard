// Internal single-operator dashboard: render fully client-side so every data
// fetch is a plain same-origin `/api/*` call (vite proxy in dev, reverse
// proxy in production) and the web server needs no configuration at all.
export const ssr = false;
