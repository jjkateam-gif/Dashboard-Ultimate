const fetch = require('node-fetch');
const { XMLParser } = require('fast-xml-parser');
const crypto = require('crypto');

const RSS_FEEDS = [
  { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', source: 'CoinDesk' },
  { url: 'https://cointelegraph.com/rss', source: 'Cointelegraph' },
  { url: 'https://decrypt.co/feed', source: 'Decrypt' },
];

const POLL_INTERVAL = 2 * 60 * 1000; // 2 minutes

// Weighted keyword lists: { word, weight }
const STRONG_POSITIVE = ['surge', 'soars', 'breakout', 'ath', 'all-time high'];
const MODERATE_POSITIVE = ['gains', 'rally', 'adoption', 'upgrade', 'accumulation', 'institutional', 'halving', 'recovery', 'momentum'];
const MILD_POSITIVE = ['partnership', 'milestone', 'integration', 'listing', 'mainnet', 'airdrop', 'expansion', 'approval', 'bullish', 'inflows', 'record'];

const STRONG_NEGATIVE = ['crash', 'hack', 'exploit', 'scam', 'fraud', 'rug pull', 'rugpull', 'ponzi'];
const MODERATE_NEGATIVE = ['selloff', 'plunge', 'dump', 'lawsuit', 'insolvency', 'bankruptcy', 'delisted', 'liquidation'];
const MILD_NEGATIVE = ['crackdown', 'outflows', 'vulnerability', 'ban', 'bearish', 'sec charges', 'contagion', 'frozen', 'investigation'];

const POSITIVE_WORDS = [
  ...STRONG_POSITIVE.map(w => ({ word: w, weight: 0.8 })),
  ...MODERATE_POSITIVE.map(w => ({ word: w, weight: 0.5 })),
  ...MILD_POSITIVE.map(w => ({ word: w, weight: 0.3 })),
];
const NEGATIVE_WORDS = [
  ...STRONG_NEGATIVE.map(w => ({ word: w, weight: -0.8 })),
  ...MODERATE_NEGATIVE.map(w => ({ word: w, weight: -0.5 })),
  ...MILD_NEGATIVE.map(w => ({ word: w, weight: -0.3 })),
];

// FIX 1: Word boundary matching instead of substring includes
const wordMatch = (text, word) => new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text);

// FIX 3: Negation handling
const NEGATION_WORDS = ['not', 'no', 'never', 'fails to', 'failed to', 'without', 'lack of', 'unlikely', "don't", "doesn't", "didn't", "won't", "isn't", "aren't"];

function isNegated(text, word) {
  const idx = text.indexOf(word);
  if (idx === -1) return false;
  const before = text.substring(Math.max(0, idx - 30), idx).toLowerCase();
  return NEGATION_WORDS.some(neg => before.includes(neg));
}

let articles = [];
let seenUrls = new Set();
let sseClients = [];
let pollTimer = null;

function hashUrl(url) {
  return crypto.createHash('md5').update(url).digest('hex');
}

function stripHtml(str) {
  if (!str) return '';
  return str.replace(/<[^>]*>/g, '').replace(/&[^;]+;/g, ' ').trim();
}

function scoreSentiment(title, desc) {
  const text = ((title || '') + ' ' + (desc || '')).toLowerCase();
  let score = 0;

  for (const { word, weight } of POSITIVE_WORDS) {
    if (wordMatch(text, word)) {
      if (isNegated(text, word)) {
        // Negated positive -> count as mild negative
        score -= 0.3;
      } else {
        score += weight;
      }
    }
  }
  for (const { word, weight } of NEGATIVE_WORDS) {
    if (wordMatch(text, word)) {
      if (isNegated(text, word)) {
        // Negated negative -> count as mild positive
        score += 0.3;
      } else {
        score += weight; // weight is already negative
      }
    }
  }

  // Clamp score to [-1, 1]
  score = Math.max(-1, Math.min(1, score));

  let label = 'neutral';
  if (score > 0.1) label = 'bullish';
  else if (score < -0.1) label = 'bearish';

  return { score: Math.round(score * 100) / 100, label };
}

function parseFeed(xml, sourceName) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
  });

  const parsed = parser.parse(xml);
  let items = [];

  try {
    const channel = parsed.rss && parsed.rss.channel;
    if (!channel) return [];
    items = channel.item || [];
    if (!Array.isArray(items)) items = [items];
  } catch (e) {
    console.error(`parseFeed error for ${sourceName}:`, e.message);
    return [];
  }

  return items.map((item) => {
    const url = item.link || '';
    const title = item.title || '';
    const rawDesc = item.description || item['content:encoded'] || '';
    let description = stripHtml(rawDesc);
    if (description.length > 200) description = description.slice(0, 200) + '...';

    const pubDate = item.pubDate || item['dc:date'] || '';
    const publishedAt = pubDate ? new Date(pubDate).toISOString() : new Date().toISOString();

    // Categories
    let categories = [];
    if (item.category) {
      categories = Array.isArray(item.category) ? item.category : [item.category];
      categories = categories.map((c) => (typeof c === 'string' ? c : c['#text'] || '')).filter(Boolean);
    }

    // Image URL from media:content or enclosure
    let imageUrl = null;
    if (item['media:content'] && item['media:content']['@_url']) {
      imageUrl = item['media:content']['@_url'];
    } else if (item.enclosure && item.enclosure['@_url']) {
      imageUrl = item.enclosure['@_url'];
    }

    const sentiment = scoreSentiment(title, description);

    return {
      id: hashUrl(url),
      title,
      description,
      url,
      source: sourceName,
      publishedAt,
      categories,
      imageUrl,
      sentiment,
    };
  });
}

async function fetchFeed(feed) {
  const res = await fetch(feed.url, {
    timeout: 15000,
    headers: { 'User-Agent': 'CryptoDashboard/1.0' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${feed.source}`);
  const xml = await res.text();
  return parseFeed(xml, feed.source);
}

async function pollAllFeeds() {
  const results = await Promise.allSettled(
    RSS_FEEDS.map((feed) => fetchFeed(feed))
  );

  const newArticles = [];

  for (const result of results) {
    if (result.status === 'fulfilled') {
      for (const article of result.value) {
        if (!seenUrls.has(article.url) && article.url) {
          seenUrls.add(article.url);
          newArticles.push(article);
        }
      }
    } else {
      console.error('Feed fetch error:', result.reason?.message || result.reason);
    }
  }

  if (newArticles.length > 0) {
    articles = [...newArticles, ...articles]
      .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
      .slice(0, 100);

    // Rebuild seenUrls from surviving articles to prevent unbounded growth
    seenUrls = new Set(articles.map(a => a.url));

    broadcastNew(newArticles);
    console.log(`[NewsAggregator] ${newArticles.length} new articles. Total: ${articles.length}`);
  }
}

function start() {
  if (pollTimer) return;
  console.log('[NewsAggregator] Starting polling...');
  pollAllFeeds();
  pollTimer = setInterval(pollAllFeeds, POLL_INTERVAL);
}

function stop() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    console.log('[NewsAggregator] Stopped.');
  }
}

function getArticles(limit = 50, category = 'all') {
  let filtered = articles;
  if (category && category !== 'all') {
    const cat = category.toLowerCase();
    filtered = articles.filter((a) =>
      a.categories.some((c) => c.toLowerCase().includes(cat))
    );
  }
  return filtered.slice(0, limit);
}

function getSentimentRolling(hours) {
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
  const recent = articles.filter((a) => new Date(a.publishedAt) >= cutoff);

  const count = recent.length;

  // FIX 5: Confidence based on sample size
  let confidence;
  if (count >= 10) confidence = 'high';
  else if (count >= 5) confidence = 'medium';
  else if (count >= 1) confidence = 'low';
  else confidence = 'none';

  if (count === 0) {
    return { score: 0, label: 'neutral', count: 0, confidence };
  }

  const avgScore =
    recent.reduce((sum, a) => sum + a.sentiment.score, 0) / count;
  const clampedScore = Math.max(-1, Math.min(1, avgScore));

  let label = 'neutral';
  if (clampedScore > 0.1) label = 'bullish';
  else if (clampedScore < -0.1) label = 'bearish';

  return { score: Math.round(clampedScore * 100) / 100, label, count, confidence };
}

function addSseClient(res) {
  sseClients.push(res);
}

function removeSseClient(res) {
  sseClients = sseClients.filter((c) => c !== res);
}

function broadcastNew(newArticles) {
  const data = JSON.stringify(newArticles);
  const message = `event: news\ndata: ${data}\n\n`;

  for (const client of sseClients) {
    try {
      client.write(message);
    } catch (e) {
      // client disconnected
    }
  }
}

module.exports = {
  start,
  stop,
  getArticles,
  getSentimentRolling,
  addSseClient,
  removeSseClient,
};
