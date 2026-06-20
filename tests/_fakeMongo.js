import { ObjectId } from 'mongodb';

function deepClone(v) {
  if (v === null || v === undefined) return v;
  if (typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(deepClone);
  if (v.constructor && v.constructor.name === 'ObjectId') return v;
  if (v instanceof Date) return new Date(v.getTime());
  const out = {};
  for (const [k, val] of Object.entries(v)) out[k] = deepClone(val);
  return out;
}

function isObjectId(v) {
  return v && typeof v === 'object' && v.constructor && v.constructor.name === 'ObjectId';
}

function isOperatorQuery(v) {
  if (!v || typeof v !== 'object') return false;
  if (Array.isArray(v)) return false;
  if (v instanceof Date) return false;
  if (isObjectId(v)) return false;
  const keys = Object.keys(v);
  return keys.length > 0 && keys.every((k) => k.startsWith('$'));
}

function matchOperator(dv, op) {
  for (const [k, v] of Object.entries(op)) {
    switch (k) {
      case '$gte':
        if (dv === undefined || dv === null || !(dv >= v)) return false;
        break;
      case '$gt':
        if (dv === undefined || dv === null || !(dv > v)) return false;
        break;
      case '$lte':
        if (dv === undefined || dv === null || !(dv <= v)) return false;
        break;
      case '$lt':
        if (dv === undefined || dv === null || !(dv < v)) return false;
        break;
      case '$ne':
        if (dv === v) return false;
        break;
      case '$exists':
        if (Boolean(v) !== (dv !== undefined)) return false;
        break;
      default:
        return false;
    }
  }
  return true;
}

function matchesScalar(dv, v) {
  if (v === null) return dv === null || dv === undefined;
  if (isObjectId(v)) {
    if (dv === undefined || dv === null) return false;
    if (typeof dv.equals === 'function') return dv.equals(v);
    return false;
  }
  if (
    dv !== undefined &&
    dv !== null &&
    typeof dv === 'object' &&
    typeof dv.equals === 'function' &&
    v !== undefined &&
    v !== null &&
    typeof v === 'object' &&
    typeof v.equals === 'function'
  ) {
    return dv.equals(v);
  }
  if (isOperatorQuery(v)) return matchOperator(dv, v);
  return dv === v;
}

// Walk a dotted path through `doc`, fanning out across any array we encounter
// (Mongo's standard "implicit any" semantics on array fields). Returns the
// flat list of leaf values reachable along that path.
function valuesAtPath(doc, parts) {
  let stack = [doc];
  for (const part of parts) {
    const next = [];
    for (const v of stack) {
      if (v === null || v === undefined) continue;
      if (Array.isArray(v)) {
        for (const item of v) {
          if (item == null) continue;
          if (typeof item === 'object') next.push(item[part]);
        }
      } else if (typeof v === 'object') {
        next.push(v[part]);
      }
    }
    stack = next;
  }
  return stack;
}

function matchQuery(doc, query) {
  for (const [k, v] of Object.entries(query || {})) {
    if (k.includes('.')) {
      const values = valuesAtPath(doc, k.split('.'));
      if (!values.some((dv) => matchesScalar(dv, v))) return false;
      continue;
    }
    const dv = doc[k];
    if (!matchesScalar(dv, v)) return false;
  }
  return true;
}

// For positional `$` updates: find the index in the FIRST array-traversing
// query path that matched, mirroring Mongo's positional-$ semantics.
function findPositionalIndex(doc, query) {
  for (const [k, v] of Object.entries(query || {})) {
    if (!k.includes('.')) continue;
    const parts = k.split('.');
    const arrName = parts[0];
    const arr = doc[arrName];
    if (!Array.isArray(arr)) continue;
    const remaining = parts.slice(1);
    for (let i = 0; i < arr.length; i++) {
      const item = arr[i];
      if (item == null) continue;
      const dv = remaining.reduce(
        (o, p) => (o == null || typeof o !== 'object' ? undefined : o[p]),
        item,
      );
      if (matchesScalar(dv, v)) return { arrName, index: i };
    }
  }
  return null;
}

// Resolve a path containing `$[name]` placeholders against `arrayFilters`,
// returning every concrete path (array of segments) that satisfies the
// filters. Supports an arbitrary number of nested array filters.
function resolveArrayFilterPaths(target, path, arrayFilters) {
  const filtersByName = {};
  for (const af of arrayFilters || []) {
    const firstKey = Object.keys(af)[0];
    if (!firstKey) continue;
    const name = firstKey.split('.')[0];
    filtersByName[name] = af;
  }
  const parts = path.split('.');
  let stack = [{ ref: target, parts: [] }];
  for (const part of parts) {
    const m = /^\$\[([^\]]+)\]$/.exec(part);
    if (m) {
      const name = m[1];
      const filter = filtersByName[name];
      if (!filter) throw new Error(`Missing arrayFilter for "${name}" while resolving "${path}"`);
      const next = [];
      for (const cur of stack) {
        const arr = cur.ref;
        if (!Array.isArray(arr)) continue;
        for (let i = 0; i < arr.length; i++) {
          const item = arr[i];
          if (item == null) continue;
          let allMatch = true;
          for (const [fk, fv] of Object.entries(filter)) {
            const fparts = fk.split('.');
            // Filter keys are scoped by the placeholder name, so strip it.
            const fieldParts = fparts[0] === name ? fparts.slice(1) : fparts;
            const dv = fieldParts.length
              ? fieldParts.reduce(
                  (o, p) => (o == null || typeof o !== 'object' ? undefined : o[p]),
                  item,
                )
              : item;
            if (!matchesScalar(dv, fv)) {
              allMatch = false;
              break;
            }
          }
          if (allMatch) next.push({ ref: item, parts: [...cur.parts, i] });
        }
      }
      stack = next;
    } else {
      const next = [];
      for (const cur of stack) {
        if (cur.ref == null || typeof cur.ref !== 'object') continue;
        next.push({ ref: cur.ref[part], parts: [...cur.parts, part] });
      }
      stack = next;
    }
  }
  return stack.map((s) => s.parts);
}

function resolveUpdatePath(target, path, positional, arrayFilters) {
  if (path.includes('$[')) {
    return resolveArrayFilterPaths(target, path, arrayFilters);
  }
  if (path.includes('.$.') || path.endsWith('.$')) {
    if (!positional) {
      throw new Error(`Update path "${path}" needs a positional match but query had none`);
    }
    return [path.split('.').map((p) => (p === '$' ? positional.index : p))];
  }
  return [path.split('.')];
}

function setAtPath(target, parts, value) {
  let node = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (node[p] === undefined || node[p] === null) {
      // Create container: if next segment is numeric, init array; else object.
      const nextSeg = parts[i + 1];
      node[p] = typeof nextSeg === 'number' ? [] : {};
    }
    node = node[p];
  }
  node[parts[parts.length - 1]] = value;
}

function getAtPath(target, parts) {
  let node = target;
  for (const p of parts) {
    if (node == null) return undefined;
    node = node[p];
  }
  return node;
}

function deleteAtPath(target, parts) {
  let node = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (node == null || typeof node !== 'object') return;
    node = node[p];
  }
  if (node == null || typeof node !== 'object') return;
  delete node[parts[parts.length - 1]];
}

function makeCursor(arr) {
  let docs = [...arr];
  let sortSpec = null;
  let limitN = null;
  return {
    sort(spec) {
      sortSpec = spec;
      return this;
    },
    limit(n) {
      limitN = n;
      return this;
    },
    async toArray() {
      let out = [...docs];
      if (sortSpec) {
        const entries = Object.entries(sortSpec);
        out.sort((a, b) => {
          for (const [k, dir] of entries) {
            const av = a[k];
            const bv = b[k];
            if (av < bv) return -1 * dir;
            if (av > bv) return dir;
          }
          return 0;
        });
      }
      if (limitN !== null) out = out.slice(0, limitN);
      return out.map(deepClone);
    },
  };
}

function makeCollection() {
  const docs = [];
  return {
    _docs: docs,
    async findOne(query) {
      const found = docs.find((d) => matchQuery(d, query));
      return found ? deepClone(found) : null;
    },
    async insertOne(doc) {
      if (doc._id === undefined) doc._id = new ObjectId();
      docs.push(deepClone(doc));
      return { insertedId: doc._id };
    },
    async insertMany(arr) {
      const insertedIds = {};
      (arr || []).forEach((doc, i) => {
        if (doc._id === undefined) doc._id = new ObjectId();
        docs.push(deepClone(doc));
        insertedIds[i] = doc._id;
      });
      return { insertedCount: (arr || []).length, insertedIds };
    },
    async updateOne(query, update, options = {}) {
      const idx = docs.findIndex((d) => matchQuery(d, query));
      if (idx < 0) {
        if (update.$setOnInsert || update.upsert || options.upsert) {
          const seed = { ...query, ...(update.$setOnInsert || {}), ...(update.$set || {}) };
          if (seed._id === undefined) seed._id = new ObjectId();
          docs.push(deepClone(seed));
          return { matchedCount: 0, upsertedId: seed._id };
        }
        return { matchedCount: 0 };
      }
      const target = docs[idx];
      const positional = findPositionalIndex(target, query);
      const arrayFilters = options.arrayFilters || [];

      if (update.$set) {
        for (const [path, value] of Object.entries(update.$set)) {
          const resolved = resolveUpdatePath(target, path, positional, arrayFilters);
          for (const parts of resolved) {
            setAtPath(target, parts, deepClone(value));
          }
        }
      }
      if (update.$push) {
        for (const [path, value] of Object.entries(update.$push)) {
          const resolved = resolveUpdatePath(target, path, positional, arrayFilters);
          for (const parts of resolved) {
            let arr = getAtPath(target, parts);
            if (!Array.isArray(arr)) {
              setAtPath(target, parts, []);
              arr = getAtPath(target, parts);
            }
            arr.push(deepClone(value));
          }
        }
      }
      if (update.$pull) {
        for (const [path, cond] of Object.entries(update.$pull)) {
          const resolved = resolveUpdatePath(target, path, positional, arrayFilters);
          for (const parts of resolved) {
            const arr = getAtPath(target, parts);
            if (!Array.isArray(arr)) continue;
            const filtered = arr.filter((item) => {
              if (cond && typeof cond === 'object' && !isObjectId(cond) && !isOperatorQuery(cond)) {
                return !matchQuery(item, cond);
              }
              return !matchesScalar(item, cond);
            });
            setAtPath(target, parts, filtered);
          }
        }
      }
      if (update.$unset) {
        for (const path of Object.keys(update.$unset)) {
          const resolved = resolveUpdatePath(target, path, positional, arrayFilters);
          for (const parts of resolved) deleteAtPath(target, parts);
        }
      }
      return { matchedCount: 1 };
    },
    async updateMany(query, update, options = {}) {
      const matched = docs.filter((d) => matchQuery(d, query));
      const arrayFilters = options.arrayFilters || [];
      for (const target of matched) {
        const positional = findPositionalIndex(target, query);
        if (update.$set) {
          for (const [path, value] of Object.entries(update.$set)) {
            const resolved = resolveUpdatePath(target, path, positional, arrayFilters);
            for (const parts of resolved) setAtPath(target, parts, deepClone(value));
          }
        }
        if (update.$unset) {
          for (const path of Object.keys(update.$unset)) {
            const resolved = resolveUpdatePath(target, path, positional, arrayFilters);
            for (const parts of resolved) deleteAtPath(target, parts);
          }
        }
      }
      return { matchedCount: matched.length, modifiedCount: matched.length };
    },
    async deleteOne(query) {
      const idx = docs.findIndex((d) => matchQuery(d, query));
      if (idx < 0) return { deletedCount: 0 };
      docs.splice(idx, 1);
      return { deletedCount: 1 };
    },
    find(query = {}) {
      return makeCursor(docs.filter((d) => matchQuery(d, query)));
    },
    async createIndex() {
      return undefined;
    },
  };
}

export function createFakeDb() {
  const cols = new Map();
  return {
    collection(name) {
      if (!cols.has(name)) cols.set(name, makeCollection());
      return cols.get(name);
    },
    _cols: cols,
    reset() {
      cols.clear();
    },
  };
}
