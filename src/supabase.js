import { createClient } from '@supabase/supabase-js';

/* Accepts either our own VITE_ names or the NEXT_PUBLIC_ names that the Vercel
   Supabase integration writes into the project automatically (see vite.config.js). */
const env = import.meta.env;

const url = env.VITE_SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
const key =
  env.VITE_SUPABASE_ANON_KEY ||
  env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

export const configured = Boolean(url && key);
export const supabase = configured ? createClient(url, key) : null;
export const BUCKET = 'takes';
