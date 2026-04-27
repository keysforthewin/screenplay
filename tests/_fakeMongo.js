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

function applySet(target, set) {
  for (const [path, value] of Object.entries(set || {})) {
    if (!path.includes('.')) {
      target[path] = value;
      continue;
    }
    const parts = path.split('.');
    let node = target;
    for (let i = 0; i < parts.length - 1; i++) {
      if (typeof node[parts[i]] !== 'object' || node[parts[i]] === null) node[parts[i]] = {};
      node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = value;
  }
}

function isOperatorQuery(v) {
  if (!v || typeof v !== 'object') return false;
  if (Array.isArray(v)) return false;
  if (v instanceof Date) return false;
  if (v.constructor && v.constructor.name === 'ObjectId') return false;
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
      default:
        return false;
    }
  }
  return true;
}

function matchQuery(doc, query) {
  for (const [k, v] of Object.entries(query || {})) {
    const dv = k.split('.').reduce((o, key) => (o == null ? undefined : o[key]), doc);
    if (v === null) {
      if (dv !== null && dv !== undefined) return false;
      continue;
    }
    if (typeof v === 'object' && v && v.constructor && v.constructor.name === 'ObjectId') {
      if (!dv || typeof dv.equals !== 'function' || !dv.equals(v)) return false;
      continue;
    }
    if (typeof dv !== 'undefined' && dv !== null && typeof dv.equals === 'function' && typeof v !== 'undefined' && v !== null && typeof v.equals === 'function') {
      if (!dv.equals(v)) return false;
      continue;
    }
    if (isOperatorQuery(v)) {
      if (!matchOperator(dv, v)) return false;
      continue;
    }
    if (dv !== v) return false;
  }
  return true;
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
        const [[k, dir]] = Object.entries(sortSpec);
        out.sort((a, b) => {
          const av = a[k];
          const bv = b[k];
          if (av < bv) return -1 * dir;
          if (av > bv) return dir;
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
      if (update.$set) applySet(target, update.$set);
      if (update.$push) {
        for (const [k, v] of Object.entries(update.$push)) {
          if (!Array.isArray(target[k])) target[k] = [];
          target[k].push(deepClone(v));
        }
      }
      if (update.$pull) {
        for (const [k, cond] of Object.entries(update.$pull)) {
          if (!Array.isArray(target[k])) continue;
          target[k] = target[k].filter((item) => !matchQuery(item, cond));
        }
      }
      return { matchedCount: 1 };
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
