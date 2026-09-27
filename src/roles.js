/* Instrument roles. The database table public.roles is authoritative for slots
   (let_in() and can_vote() read it). Keep ids, labels and slots here in sync with
   supabase/migrations; colours and icons only live here. */

export var ROLES = [
  { id:'drums',  label:'Drums',         slots:1, color:'--drums',  icon:'drums'  },
  { id:'guitar', label:'Rhythm guitar', slots:1, color:'--guitar', icon:'guitar' },
  { id:'bass',   label:'Bass',          slots:1, color:'--bass',   icon:'bass'   },
  { id:'lead',   label:'Lead',          slots:2, color:'--lead',   icon:'guitar' },
  { id:'atmos',  label:'Atmosphere',    slots:2, color:'--atmos',  icon:'atmos'  },
  { id:'wild',   label:'Wildcard',      slots:2, color:'--wild',   icon:'wild'   }
];

export function role(id) {
  if (id === 'seed') return { id:'seed', label:'Seed', slots:1, color:'--ember', icon:'seed' };
  if (id === 'mix') return { id:'mix', label:'Mix', slots:1, color:'--cyan', icon:'prod' };
  return ROLES.filter(function (r) { return r.id === id; })[0];
}

export function col(r) { return 'var(' + r.color + ')'; }

export function cvar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
}
