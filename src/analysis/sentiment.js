import Sentiment from 'sentiment';

const analyzer = new Sentiment();

export function scoreSentiment(text) {
  const t = text === null || text === undefined ? '' : String(text);
  if (!t.trim()) {
    return { score: 0, comparative: 0, positive: [], negative: [] };
  }
  const r = analyzer.analyze(t);
  return {
    score: r.score,
    comparative: r.comparative,
    positive: r.positive || [],
    negative: r.negative || [],
  };
}

export function detectClimax(series, metric = 'max_deviation') {
  const items = Array.isArray(series) ? series : [];
  if (items.length === 0) return { error: 'No beats provided.' };

  const scored = items.map((it) => ({
    id: it.id,
    order: it.order,
    comparative: scoreSentiment(it.text).comparative,
  }));

  const total = scored.reduce((s, x) => s + x.comparative, 0);
  const baseline = total / scored.length;

  const variance = scored.reduce(
    (s, x) => s + (x.comparative - baseline) * (x.comparative - baseline),
    0,
  ) / scored.length;
  if (variance === 0) {
    return { error: 'No sentiment variation detected across beats.' };
  }

  let climax = null;

  if (metric === 'steepest_drop') {
    if (scored.length < 2) return { error: 'Need at least 2 beats for steepest_drop.' };
    let worstDrop = 0;
    let worstIdx = -1;
    for (let i = 1; i < scored.length; i++) {
      const drop = scored[i].comparative - scored[i - 1].comparative;
      if (drop < worstDrop) {
        worstDrop = drop;
        worstIdx = i;
      }
    }
    if (worstIdx < 0) {
      return { error: 'No drop detected (sentiment is non-decreasing).' };
    }
    const c = scored[worstIdx];
    climax = {
      id: c.id,
      order: c.order,
      comparative: c.comparative,
      deviation_or_drop: worstDrop,
      normalized_position: scored.length > 1 ? worstIdx / (scored.length - 1) : 0,
    };
  } else {
    let bestIdx = 0;
    let bestAbs = Math.abs(scored[0].comparative - baseline);
    for (let i = 1; i < scored.length; i++) {
      const d = Math.abs(scored[i].comparative - baseline);
      if (d > bestAbs) {
        bestAbs = d;
        bestIdx = i;
      }
    }
    const c = scored[bestIdx];
    climax = {
      id: c.id,
      order: c.order,
      comparative: c.comparative,
      deviation_or_drop: c.comparative - baseline,
      normalized_position: scored.length > 1 ? bestIdx / (scored.length - 1) : 0,
    };
  }

  const inWindow =
    climax.normalized_position >= 0.75 && climax.normalized_position <= 0.9;

  return {
    metric: metric === 'steepest_drop' ? 'steepest_drop' : 'max_deviation',
    baseline,
    series: scored,
    climax,
    expected_window: '0.75-0.90',
    in_expected_window: inWindow,
  };
}
