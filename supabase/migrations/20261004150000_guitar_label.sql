-- "Rhythm guitar" becomes plain "Guitar": the role covers rhythm, clean and any other
-- guitar part. Only the label changes; the id stays 'guitar', so existing takes are fine.
-- Keep in sync with src/roles.js.
update public.roles set label = 'Guitar' where id = 'guitar';
