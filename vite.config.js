import { defineConfig } from 'vite';

export default defineConfig({
  // NEXT_PUBLIC_ is what the Vercel Supabase integration writes; VITE_ is for .env.local.
  // Only put public values (URL, anon/publishable key) under these prefixes.
  envPrefix: ['VITE_', 'NEXT_PUBLIC_']
});
