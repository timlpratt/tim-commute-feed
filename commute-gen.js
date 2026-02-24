const Parser = require('rss-parser');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const crypto = require('crypto');

// Load Env
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  lines.forEach(line => {
    const [key, val] = line.split('=');
    if (key && val) process.env[key.trim()] = val.trim();
  });
}

const CONFIG_PATH = path.join(__dirname, 'feeds.json');
const parser = new Parser({
  customFields: {
    item: [['itunes:duration', 'duration']]
  },
  headers: {
    'User-Agent': 'CommuteCurator/1.0 (TimBot; +https://github.com/timlpratt/tim-commute-feed)'
  }
});

function parseDuration(duration) {
  if (!duration) return 0;
  if (typeof duration === 'number') return duration / 60;
  if (!isNaN(duration)) return parseInt(duration) / 60;
  
  const parts = duration.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 60 + parts[1] + parts[2]/60;
  if (parts.length === 2) return parts[0] + parts[1] / 60;
  return 0;
}

function generateGuid(item) {
  if (item.guid) return item.guid;
  if (item.link) return item.link;
  return crypto.createHash('md5').update(item.title + item.pubDate).digest('hex');
}

function escapeXml(unsafe) {
  if (!unsafe) return '';
  return unsafe.replace(/[<>&'"]/g, function (c) {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
    }
  });
}

async function run() {
  const isThursday = new Date().getDay() === 4; 
  console.log(`🎧 Starting Commute Curator... (Day: ${new Date().getDay()}, Date Night: ${isThursday})`);
  
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const targetDuration = config.target_duration_minutes || 70;
  const rules = config.rules;

  if (isThursday) {
    console.log('❤️ DATE NIGHT MODE ACTIVE');
    rules.boost_keywords = [...rules.boost_keywords, ...rules.datenight_keywords];
    rules.block_keywords = [...rules.block_keywords, ...rules.datenight_block];
  }

  // Fetch
  let candidates = [];
  let newsBriefing = null;

  for (const feedConfig of config.feeds) {
    try {
      const feed = await parser.parseURL(feedConfig.url);
      const items = feed.items.slice(0, 5).map(item => ({
        title: item.title,
        link: item.link, 
        guid: item.guid, 
        audio_url: item.enclosure?.url,
        pubDate: new Date(item.pubDate),
        duration: parseDuration(item.duration || item.itunes?.duration),
        contentSnippet: item.contentSnippet || item.content || '',
        feedName: feedConfig.name,
        tags: feedConfig.tags || []
      })).filter(item => item.audio_url);
      
      // News Briefing Logic
      if (feedConfig.tags.includes('news') && feedConfig.tags.includes('briefing')) {
        const briefing = items.find(i => i.duration < 15);
        if (briefing && (!newsBriefing || briefing.pubDate > newsBriefing.pubDate)) {
          newsBriefing = briefing;
        }
      } else {
        candidates = candidates.concat(items);
      }

    } catch (err) {
      console.error(`❌ Failed to fetch ${feedConfig.name}:`, err.message);
    }
  }

  // Score
  const scoredItems = candidates.map(item => {
    let score = 0;
    const text = (item.title + ' ' + item.contentSnippet).toLowerCase();
    const ageInDays = (new Date() - item.pubDate) / (1000 * 60 * 60 * 24);
    
    // Base Keyword Scoring
    rules.boost_keywords.forEach(kw => { if (text.includes(kw.toLowerCase())) score += 15; });
    rules.boost_guests.forEach(guest => { if (text.includes(guest.toLowerCase())) score += 50; });
    rules.block_keywords.forEach(kw => { if (text.includes(kw.toLowerCase())) score -= 100; });

    // AGE PENALTY LOGIC
    // News/Tech/Space must be fresh (< 7 days)
    if (item.tags.some(t => ['news', 'tech', 'space', 'business'].includes(t))) {
      if (ageInDays < 2) score += 30; // Very fresh
      else if (ageInDays < 5) score += 10; // Okay
      else score -= 50; // Old news is bad news
    } else {
      // Evergreen (History, Story, Comedy)
      if (ageInDays < 7) score += 10; // New is still nice
      // No penalty for old history
    }

    // Length
    if (item.duration >= 15 && item.duration <= 60) score += 10;
    if (item.duration > 90) score -= 30; 
    if (item.duration < 5) score -= 10;

    // Date Night
    if (isThursday) {
       if (item.tags.includes('date_night')) score += 40;
       if (item.tags.includes('comedy')) score += 30;
       if (item.tags.includes('tech')) score -= 20; 
    }

    return { ...item, score };
  }).filter(item => item.score > -20);

  scoredItems.sort((a, b) => b.score - a.score);

  // Select
  let currentDuration = 0;
  const selected = [];

  if (newsBriefing) {
    const ageHours = (new Date() - newsBriefing.pubDate) / (1000 * 60 * 60);
    if (ageHours < 24) { 
      selected.push(newsBriefing);
      currentDuration += newsBriefing.duration;
      console.log(`[${Math.round(newsBriefing.duration)}m] START: ${newsBriefing.feedName}: ${newsBriefing.title}`);
    }
  }

  console.log('\n--- Selected for Commute ---');
  for (const item of scoredItems) {
    if (selected.some(s => s.title === item.title)) continue;
    if (item.duration > 90 && item.score < 50) continue;
    if (currentDuration + item.duration > targetDuration + 15 && item.score < 60) continue;
    
    selected.push(item);
    currentDuration += item.duration;
    console.log(`[${Math.round(item.duration)}m] ${item.feedName}: ${item.title} (Score: ${item.score})`);
    if (currentDuration >= targetDuration) break;
  }
  
  console.log(`\nTotal: ${Math.round(currentDuration)} mins`);

  // Generate RSS
  const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>Tim's Evening Commute${isThursday ? ' (Date Night)' : ''}</title>
    <description>Smart, relaxing mix for the drive home.</description>
    <link>https://timlpratt.github.io/tim-commute-feed/</link>
    <language>en-us</language>
    <pubDate>${new Date().toUTCString()}</pubDate>
    <itunes:author>TimBot</itunes:author>
    <itunes:image href="https://upload.wikimedia.org/wikipedia/commons/thumb/e/e4/Robot_icon.svg/1024px-Robot_icon.svg.png"/>
    <itunes:category text="Technology"/>
    <itunes:explicit>no</itunes:explicit>
    ${selected.map(item => `
    <item>
      <title>[${item.feedName}] ${escapeXml(item.title)}</title>
      <description><![CDATA[${item.contentSnippet}]]></description>
      <enclosure url="${escapeXml(item.audio_url)}" type="audio/mpeg" length="0"/>
      <guid isPermaLink="false">${escapeXml(generateGuid(item))}</guid>
      <pubDate>${item.pubDate.toUTCString()}</pubDate>
      <itunes:duration>${Math.round(item.duration * 60)}</itunes:duration>
    </item>`).join('')}
  </channel>
</rss>`;

  fs.writeFileSync('commute.xml', rss);

  console.log('\nPushing to GitHub Repo...');
  try {
    execSync('git add commute.xml', { cwd: __dirname });
    execSync(`git commit -m "Update feed $(date)"`, { cwd: __dirname });
    execSync('git push origin main', { 
      cwd: __dirname,
      env: { ...process.env, GITHUB_TOKEN: process.env.GITHUB_TOKEN }
    });
    console.log(`✅ Success! Subscribe to:\nhttps://timlpratt.github.io/tim-commute-feed/commute.xml`);
  } catch (err) {
    console.error('❌ Failed to push to repo:', err.message);
    if (err.message.includes('nothing to commit')) {
      console.log('No changes to push.');
    }
  }
}

run().catch(console.error);
