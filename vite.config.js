import { defineConfig } from 'vite';

/* /songs and /home are their own pages (songs.html, homepage.html). vercel.json
   rewrites them in production; this does the same for `npm run dev` and `npm run preview`. */
function prettyRoutes() {
  const map = { '/songs': '/songs.html', '/home': '/homepage.html' };
  const rewrite = (req, res, next) => {
    for (const from in map) {
      if (req.url === from || req.url.startsWith(from + '?')) { req.url = req.url.replace(from, map[from]); break; }
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
      input: { main: 'index.html', songs: 'songs.html', homepage: 'homepage.html' }
    }
  }
});
