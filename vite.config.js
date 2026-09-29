import { defineConfig } from 'vite';

/* /songs is its own page (songs.html). vercel.json rewrites it in production;
   this does the same for `npm run dev` and `npm run preview`. */
function songsRoute() {
  const rewrite = (req, res, next) => {
    if (req.url === '/songs' || req.url.startsWith('/songs?')) req.url = req.url.replace('/songs', '/songs.html');
    next();
  };
  return {
    name: 'songs-route',
    configureServer(server) { server.middlewares.use(rewrite); },
    configurePreviewServer(server) { server.middlewares.use(rewrite); }
  };
}

export default defineConfig({
  // NEXT_PUBLIC_ is what the Vercel Supabase integration writes; VITE_ is for .env.local.
  // Only put public values (URL, anon/publishable key) under these prefixes.
  envPrefix: ['VITE_', 'NEXT_PUBLIC_'],
  plugins: [songsRoute()],
  build: {
    rollupOptions: {
      input: { main: 'index.html', songs: 'songs.html' }
    }
  }
});
