/* Instrument roles. The database table public.roles is authoritative for slots
   (let_in() and can_vote() read it). Keep ids, labels and slots here in sync with
   supabase/migrations; colours and icons only live here.
   Slots are open for every instrument (Infinity here, null in the database): it stops
   when the creator decides, there is no per-instrument cap. */

export var ROLES = [
  { id:'drums',  label:'Drums',         slots:Infinity, color:'--drums',  icon:'drums'  },
  { id:'guitar', label:'Guitar',        slots:Infinity, color:'--guitar', icon:'guitar' },
  { id:'bass',   label:'Bass',          slots:Infinity, color:'--bass',   icon:'bass'   },
  { id:'lead',   label:'Lead',          slots:Infinity, color:'--lead',   icon:'guitar' },
  { id:'atmos',  label:'Atmosphere',    slots:Infinity, color:'--atmos',  icon:'atmos'  },
  { id:'wild',   label:'Wildcard',      slots:Infinity, color:'--wild',   icon:'wild'   },
  { id:'vocals', label:'Vocals',        slots:Infinity, color:'--vocals', icon:'vocals' }
];

export function role(id) {
  if (id === 'seed') return { id:'seed', label:'Original track', slots:1, color:'--ember', icon:'seed' };
  if (id === 'part') return { id:'part', label:'New part', slots:0, color:'--cyan', icon:'part' };
  if (id === 'mix') return { id:'mix', label:'Mix', slots:1, color:'--cyan', icon:'prod' };
  return ROLES.filter(function (r) { return r.id === id; })[0];
}

export function col(r) { return 'var(' + r.color + ')'; }

export function cvar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
}
