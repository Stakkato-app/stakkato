-- The song view now shows the thread's written replies and votes (thread_comments,
-- thread_votes) and refreshes when they change, like it does for takes. Realtime only
-- sends changes for tables in the supabase_realtime publication, so add these two.
-- Nothing is deleted from them (a deleted reply is an UPDATE), so filtering by
-- session_id works for every event.

alter publication supabase_realtime add table public.thread_comments;
alter publication supabase_realtime add table public.thread_votes;
