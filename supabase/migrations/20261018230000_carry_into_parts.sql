-- Carry tracks into a new part.
--
-- Whoever pitches a new part can tick tracks of the original track (the original track itself
-- and the takes playing on it) to keep playing under the new part: a chorus that keeps the
-- drums, or the riff once more. takes.carry lists those takes on the part; nothing is copied.
-- Every listener's browser plays them again under the part, from the part's start, repeated
-- to fill its length (and cut at its end). Credits stay with the takes' own authors.
--
-- A part that only repeats (no audio of its own) is sent with a silent file of the original
-- track's length, so every existing path (upload policy, durations, the arrangement) still holds.

alter table public.takes add column if not exists carry uuid[];

alter table public.takes drop constraint if exists takes_carry_on_parts;
alter table public.takes add constraint takes_carry_on_parts
  check (carry is null or role_id = 'part');

-- only takes of the same jam can be carried (and never a part or a mix)
create or replace function public.takes_carry_check()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.carry is null or cardinality(new.carry) = 0 then
    new.carry := null;
    return new;
  end if;
  if cardinality(new.carry) > 16 then
    raise exception 'Carry at most 16 tracks into a new part';
  end if;
  if exists (
    select 1 from unnest(new.carry) as c(id)
    where not exists (
      select 1 from takes x
      where x.id = c.id and x.session_id = new.session_id and x.role_id not in ('part', 'mix')
    )
  ) then
    raise exception 'You can only carry tracks of this jam into a new part';
  end if;
  return new;
end;
$$;

drop trigger if exists takes_carry_check on public.takes;
create trigger takes_carry_check
  before insert or update of carry on public.takes
  for each row execute function public.takes_carry_check();
