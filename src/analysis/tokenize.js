export const STOPWORDS = new Set([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'also', 'am', 'an', 'and',
  'any', 'are', 'as', 'at', 'back', 'be', 'because', 'been', 'before', 'being', 'below',
  'between', 'both', 'but', 'by', 'came', 'can', 'come', 'could', 'did', 'do', 'does',
  'doing', 'don', 'down', 'during', 'each', 'even', 'ever', 'every', 'few', 'first',
  'for', 'from', 'further', 'get', 'go', 'going', 'gonna', 'gone', 'got', 'had', 'has',
  'have', 'having', 'he', 'her', 'here', 'hers', 'herself', 'him', 'himself', 'his',
  'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'itself', 'just', 'know', 'like',
  'made', 'make', 'many', 'me', 'might', 'mine', 'more', 'most', 'much', 'must', 'my',
  'myself', 'never', 'no', 'nor', 'not', 'now', 'of', 'off', 'on', 'once', 'one', 'only',
  'or', 'other', 'others', 'our', 'ours', 'ourselves', 'out', 'over', 'own', 'really',
  'said', 'same', 'say', 'says', 'see', 'she', 'should', 'so', 'some', 'still', 'such',
  'take', 'than', 'that', 'the', 'their', 'theirs', 'them', 'themselves', 'then', 'there',
  'these', 'they', 'this', 'those', 'though', 'through', 'thus', 'to', 'too', 'two',
  'under', 'until', 'up', 'us', 'use', 'used', 'very', 'want', 'was', 'way', 'we',
  'well', 'went', 'were', 'what', 'when', 'where', 'whether', 'which', 'while', 'who',
  'whom', 'whose', 'why', 'will', 'with', 'within', 'without', 'would', 'yes', 'you',
  'your', 'yours', 'yourself', 'yourselves',
]);

const TOKEN_SPLIT = /[^\p{L}\p{N}]+/u;

export function tokenize(text) {
  if (text === null || text === undefined) return [];
  const normalized = String(text)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/['‘’ʼ]/g, '');
  return normalized.split(TOKEN_SPLIT).filter((t) => t.length > 0);
}

export function tokenizeFiltered(text) {
  return tokenize(text).filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

export function isAllStopwords(tokens) {
  if (!tokens || tokens.length === 0) return true;
  return tokens.every((t) => STOPWORDS.has(t) || t.length < 2);
}
