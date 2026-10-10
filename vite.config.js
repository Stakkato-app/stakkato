import { defineConfig } from 'vite';

/* The pretty routes: / is the homepage (index.html), /songs and /privacy are their own
   pages, and the song view (session.html) answers /new and /s/<slug>. vercel.json
   rewrites them in production; this does the same for `npm run dev` and `npm run preview`. */
const ROUTES = [
  [/^\/songs(?=$|\?)/, '/songs.html'],
  [/^\/privacy(?=$|\?)/, '/privacy.html'],
  [/^\/new(?=$|\?)/, '/session.html'],
  [/^\/s\/[\w-]+(?=$|\?)/, '/session.html']
];
function prettyRoutes() {
  const rewrite = (req, res, next) => {
    for (const [from, to] of ROUTES) {
      if (from.test(req.url)) { req.url = req.url.replace(from, to); break; }
    }
    next();
  };
  return {
    name: 'pretty-routes',
    configureServer(server) { server.middlewares.use(rewrite); },
    configurePreviewServer(server) { server.middlewares.use(rewrite); }
  };
}

export default defineConfig({
  // NEXT_PUBLIC_ is what the Vercel Supabase integration writes; VITE_ is for .env.local.
  // Only put public values (URL, anon/publishable key) under these prefixes.
  envPrefix: ['VITE_', 'NEXT_PUBLIC_'],
  plugins: [prettyRoutes()],
  build: {
    rollupOptions: {
      input: { home: 'index.html', session: 'session.html', songs: 'songs.html', privacy: 'privacy.html' }
    }
  }
});
