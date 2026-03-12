const fetch = require('node-fetch');
const { XMLParser } = require('fast-xml-parser');
const crypto = require('crypto');

const RSS_FEEDS = [
  { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', source: 'CoinDesk' },
  { url: 'https://cointelegraph.com/rss', source: 'Cointelegraph' },
  { url: 'https://decrypt.co/feed', source: 'Decrypt' },
];

const POLL_INTERVAL = 2 * 60 * 1000; // 2 minutes

const POSITIVE_WORDS = [
  'surge', 'rally', 'approval', 'bullish', 'soars', 'gains', 'breakout',
  'adoption', 'inflows', 'upgrade', 'record', 'partnership', 'milestone',
  'ath', 'all-time high',
];
const NEGATIVE_WORDS = [
  'crash', 'hack', 'ban', 'bearish', 'sec charges', 'exploit', 'scam',
  'plunge', 'selloff', 'outflows', 'lawsuit', 'crackdown', 'vulnerability',
  'fraud', 'dump',
];

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
  let positiveCount = 0;
  let negativeCount = 0;

  for (const word of POSITIVE_WORDS) {
    if (text.includes(word)) positiveCount++;
  }
  for (const word of NEGATIVE_WORDS) {
    if (text.includes(word)) negativeCount++;
  }

  let score = positiveCount - negativeCount;
  score = Math.max(-1, Math.min(1, score));

  let label = 'neutral';
  if (score > 0.1) label = 'bullish';
  else if (score < -0.1) label = 'bearish';

  return { score, label };
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

  if (recent.length === 0) {
    return { score: 0, label: 'neutral', count: 0 };
  }

  const avgScore =
    recent.reduce((sum, a) => sum + a.sentiment.score, 0) / recent.length;
  const clampedScore = Math.max(-1, Math.min(1, avgScore));

  let label = 'neutral';
  if (clampedScore > 0.1) label = 'bullish';
  else if (clampedScore < -0.1) label = 'bearish';

  return { score: Math.round(clampedScore * 100) / 100, label, count: recent.length };
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
