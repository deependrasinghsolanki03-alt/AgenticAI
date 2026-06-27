// ═══════════════════════════════════════════════════════════
//  LOCAL WhatsApp Style Extractor v2 (DETAILED)
//  Runs on YOUR machine — NO data leaves your PC
//  Passwords auto-skipped
//  
//  Usage: node local-style-extractor.mjs "path/to/chat.txt"
// ═══════════════════════════════════════════════════════════

import fs from 'fs';
import path from 'path';

// ── Config — CHANGE THESE ──
const YOUR_NAME_HINT = "emoji";  // "emoji", "~", or your WhatsApp name
const RELATIONSHIP = "girlfriend";

// ── WhatsApp line parser ──
const WA_REGEX = /^\d{1,2}\/\d{1,2}\/\d{2,4},?\s*\d{1,2}:\d{2}\s*(?:am|pm|AM|PM)?\s*-\s*(.+?):\s*(.+)$/;

// Sensitive patterns to auto-skip
const SENSITIVE_PATTERNS = /password|passwd|pwd|pass:|pin:|otp|secret|token|cvv|card\s*number|account\s*no|ifsc|upi/i;

function parseChat(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n');
  const senders = new Map();
  let skippedSensitive = 0;
  
  for (const line of lines) {
    const match = line.match(WA_REGEX);
    if (!match) continue;
    const sender = match[1].trim();
    const msg = match[2].trim();
    
    // Skip ALL WhatsApp system/auto messages
    if (msg === '<Media omitted>' || msg === 'This message was deleted' || msg === '<This message was edited>') continue;
    if (msg.match(/^(You deleted this message|This message was deleted|.*waiting for this message|.*Messages and calls are end-to-end encrypted|.*security code changed|.*created group|.*added you|.*removed you|.*left|.*changed the subject|.*changed this group|.*changed the group|Missed voice call|Missed video call|.*joined using this group|.*phone number changed|Location shared|Live location shared|image omitted|video omitted|audio omitted|sticker omitted|document omitted|Contact card omitted|GIF omitted|\d+ messages? forwarded)$/i)) continue;
    // Skip messages that are JUST system text fragments
    if (msg.match(/^(you deleted this message|this message was deleted|message was edited|this message was edited|deleted this message)$/i)) continue;
    if (SENSITIVE_PATTERNS.test(msg)) { skippedSensitive++; continue; }
    
    if (!senders.has(sender)) senders.set(sender, []);
    senders.get(sender).push(msg);
  }
  
  if (skippedSensitive > 0) console.log(`🔒 ${skippedSensitive} sensitive messages auto-skipped (passwords/OTPs/etc.)`);
  return senders;
}

function identifyUser(senders) {
  const all = [...senders.entries()];
  if (all.length < 2) { console.error('❌ Chat mein 2 log chahiye!'); process.exit(1); }
  
  const hint = YOUR_NAME_HINT.toLowerCase();
  for (const [name, msgs] of all) {
    const nameLower = name.toLowerCase();
    if (nameLower.includes(hint) || hint.includes(nameLower)) {
      const other = all.find(([n]) => n !== name);
      return { userName: name, contactName: other[0], userMsgs: msgs, contactMsgs: other[1] };
    }
    if (name.match(/[^\w\s]/) && (hint.includes('emoji') || hint.includes('~') || hint.includes('symbol'))) {
      const other = all.find(([n]) => n !== name);
      return { userName: name, contactName: other[0], userMsgs: msgs, contactMsgs: other[1] };
    }
  }
  
  const sorted = all.sort((a, b) => b[1].length - a[1].length);
  return { userName: sorted[0][0], contactName: sorted[1][0], userMsgs: sorted[0][1], contactMsgs: sorted[1][1] };
}

// ═══════════════════════════════════════
//  DETAILED STYLE ANALYSIS
// ═══════════════════════════════════════

function analyzeStyle(messages) {
  const allText = messages.join(' ');
  const allTextLower = allText.toLowerCase();
  
  // ════════════════════════════════
  // 1. LANGUAGE DETECTION (Improved)
  // ════════════════════════════════
  const hinglishWords = [
    'hai', 'kya', 'nahi', 'toh', 'bhi', 'aur', 'ka', 'ki', 'ke', 'se', 'mai', 'mein',
    'hoon', 'hun', 'tha', 'thi', 'raha', 'rahi', 'karo', 'karna', 'kar', 'abhi', 'woh',
    'yeh', 'tera', 'mera', 'meri', 'tumhara', 'tumhari', 'accha', 'theek', 'haan', 'nah',
    'matlab', 'dekh', 'chal', 'bol', 'sun', 'baat', 'pyar', 'yaar', 'bhai', 'dost',
    'bahut', 'bohot', 'zyada', 'thoda', 'bilkul', 'pakka', 'sach', 'jhoot', 'pata',
    'chalo', 'achha', 'sahi', 'galat', 'samajh', 'padh', 'likh', 'de', 'le', 'ja',
    'aa', 'gaya', 'gayi', 'aaya', 'aayi', 'kaise', 'kaisa', 'kaisi', 'kitna', 'kitni',
    'kab', 'kahan', 'kyun', 'kyu', 'isliye', 'waise', 'jaise', 'tarah', 'waala', 'wali',
    'hota', 'hoti', 'karta', 'karti', 'lagta', 'lagti', 'milta', 'milti', 'rehta', 'rehti',
    'khana', 'pani', 'neend', 'kaam', 'ghar', 'bahar', 'andar', 'upar', 'niche',
    'kal', 'aaj', 'parso', 'subah', 'shaam', 'raat', 'dopahar', 'abhi', 'baad',
    'pehle', 'fir', 'phir', 'tab', 'jab', 'agar', 'lekin', 'par', 'magar', 'ya',
    'sab', 'kuch', 'koi', 'kahin', 'kabhi', 'hamesha', 'zaroor', 'shayad', 'bas',
    'wala', 'wali', 'wale', 'ruk', 'sun', 'bol', 'bolo', 'batao', 'dikhao',
    'laga', 'lag', 'hogaya', 'hogayi', 'karenge', 'jayenge', 'milenge', 'ayenge',
    'bola', 'boli', 'socha', 'sochi', 'dekha', 'dekhi', 'suna', 'suni',
    'tum', 'tumhe', 'tumko', 'mujhe', 'mujhse', 'usse', 'isse', 'unhe', 'inhe',
    'apna', 'apni', 'apne', 'khud', 'dono', 'teeno', 'sabko', 'kisiko',
    'warna', 'nahi toh', 'chahe', 'bhale', 'islye', 'taki', 'kyuki', 'kuki',
    'bro', 'yar', 'behen', 'didi', 'bhaiya', 'papa', 'mummy', 'maa',
    'kha', 'pi', 'so', 'uth', 'baith', 'chal', 'ruk', 'bhag', 'aaja', 'jaa',
    'lena', 'dena', 'rakhna', 'bhoolna', 'yaad', 'puchh', 'soch', 'samjh',
    'mast', 'badhiya', 'zabardast', 'fatafat', 'jaldi', 'dheere', 'aaram',
    'paisa', 'paise', 'rupaye', 'time', 'jagah', 'cheez', 'log', 'banda', 'bandi',
    'chod', 'rehne', 'jaane', 'hatt', 'arrey', 'oye', 'abe', 'are', 'hmm',
    'bna', 'bhi', 'krna', 'krte', 'krti', 'krta', 'ho', 'hoga', 'hogi',
    'krke', 'hoke', 'jake', 'aake', 'leke', 'deke', 'bnake', 'krke'
  ];
  
  let hinglishCount = 0;
  let englishCount = 0;
  const words = allTextLower.split(/\s+/);
  for (const w of words) {
    if (hinglishWords.includes(w.replace(/[^a-z]/g, ''))) hinglishCount++;
    else if (w.match(/^[a-z]{3,}$/)) englishCount++;
  }
  const hindiScript = (allText.match(/[\u0900-\u097F]/g) || []).length;
  
  let language = 'English';
  if (hindiScript > 100) language = 'Hindi (Devanagari script)';
  else if (hinglishCount > englishCount * 0.2) language = 'Hinglish (Hindi + English mix)';
  else if (hinglishCount > 10) language = 'Mostly English with some Hindi words';
  
  const hinglishRatio = `${Math.round(hinglishCount / (hinglishCount + englishCount + 1) * 100)}% Hindi / ${Math.round(englishCount / (hinglishCount + englishCount + 1) * 100)}% English`;
  
  // ════════════════════════════════
  // 2. PET NAMES / NICKNAMES
  // ════════════════════════════════
  const petNamePatterns = /\b(baby|babe|babu|jaanu|jaan|shona|sweetheart|honey|darling|love|cutie|beautiful|gorgeous|pretty|handsome|meri jaan|mera babu|sunshine|angel|princess|prince|king|queen|boo|hubby|wifey|dear|sweetie|pookie|bubs|janeman|dilbar|sanam|ladoo|gudiya|guddu|pataka|chiku|chhotu|sonu|monu|golu|bunny|panda|teddy|cutu|cutuu|baccha|bacchi|bacha|pagli|paglu|pagal|bewkoof|buddhu|dumbo|silly|idiot|stupid)\b/gi;
  
  const petNameCounts = new Map();
  for (const msg of messages) {
    const matches = msg.match(petNamePatterns) || [];
    matches.forEach(m => {
      const lower = m.toLowerCase();
      petNameCounts.set(lower, (petNameCounts.get(lower) || 0) + 1);
    });
  }
  const petNames = [...petNameCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name} (${count}x)`);
  
  // ════════════════════════════════
  // 3. EMOJI ANALYSIS (Deep)
  // ════════════════════════════════
  const emojiRegex = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{200D}\u{20E3}\u{2764}\u{FE0F}]/gu;
  
  const emojiCount = new Map();
  let totalEmojis = 0;
  let msgsWithEmoji = 0;
  for (const msg of messages) {
    const emojis = msg.match(emojiRegex) || [];
    if (emojis.length > 0) msgsWithEmoji++;
    totalEmojis += emojis.length;
    emojis.forEach(e => emojiCount.set(e, (emojiCount.get(e) || 0) + 1));
  }
  const topEmojis = [...emojiCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  const emojiPerMsg = (totalEmojis / messages.length).toFixed(2);
  const emojiPercent = Math.round(msgsWithEmoji / messages.length * 100);
  
  let emojiStyle = 'minimal';
  if (emojiPercent > 60) emojiStyle = 'heavy emoji user — almost every message has emojis';
  else if (emojiPercent > 30) emojiStyle = 'moderate — uses emojis regularly';
  else if (emojiPercent > 10) emojiStyle = 'occasional — uses emojis sometimes';
  
  // ════════════════════════════════
  // 4. TONE / MOOD ANALYSIS
  // ════════════════════════════════
  const tonePatterns = {
    'romantic/flirty': /\b(love|pyar|miss|jaanu|jaan|baby|babe|kiss|hug|❤|💕|💗|😘|😍|🥰|dil|heart|romantic|i love|love you|miss you|miss karta|miss karti|bohot miss|yaad aa rahi|yaad aata)\b/gi,
    'funny/playful': /\b(lol|haha|hehe|hihi|😂|🤣|rofl|lmao|funny|mazak|joke|bakwas|pagal|pagli|bewkoof|buddhu|troll|😜|😝|🤪|hassi|hasi|comedy)\b/gi,
    'caring/protective': /\b(take care|dhyan|khayal|theek|safe|health|careful|worried|tension|fikar|kha liya|so ja|pani|dawai|rest|aram|aaram|tabiyat|bimar|cold|fever)\b/gi,
    'sweet/affectionate': /\b(sweet|cute|aww|🥺|💖|lovely|adorable|precious|cutest|sweetest|pyari|pyara|sundar|khoobsurat|best|sabse|proud|happy|khush)\b/gi,
    'dramatic/expressive': /\b(omg|oh my god|what|kya|seriously|sach|jhooth|nahi|impossible|unbelievable|pagal|crazy|mad|insane|😱|😳|🤯|arrey|ohhh|woww|haww)\b/gi,
    'possessive/jealous': /\b(mera|meri|sirf mera|sirf meri|kisi aur|kisi ke|jealous|jealousy|possessive|only mine|bas mera|bas meri)\b/gi,
    'supportive/motivational': /\b(proud|kar lega|kar legi|ho jayega|don't worry|tension mat|fikar mat|best|amazing|great|awesome|you can|tu kar|tum kar|himmat)\b/gi,
    'sarcastic/teasing': /\b(oh really|achha ji|wah|great|nice|sure|haan haan|theek hai|jo bolo|as if|yeah right|obviously|🙄|😏|hmm)\b/gi,
  };
  
  const toneScores = {};
  for (const [tone, regex] of Object.entries(tonePatterns)) {
    toneScores[tone] = (allText.match(regex) || []).length;
  }
  const sortedTones = Object.entries(toneScores)
    .filter(([, v]) => v > 3)
    .sort((a, b) => b[1] - a[1]);
  
  // ════════════════════════════════
  // 5. WRITING STYLE PATTERNS
  // ════════════════════════════════
  
  // Abbreviation style
  const abbreviations = new Map();
  const abbrPatterns = /\b(tu|tum|tmhara|tmhari|mko|tko|sko|kro|kri|krna|krni|krte|bna|bnaya|bnao|bhj|bhejo|bhjdo|btao|btaya|smjh|smjha|pdhna|dkh|dkho|lko|skte|skti|hme|hmne|unhe|inhe|kch|sb|yr|bc|mc|wtf|omg|brb|btw|nvm|idk|idc|imo|ikr|tbh|lmk|hmu|ft|lol|rofl|lmao|af)\b/gi;
  for (const msg of messages) {
    const matches = msg.match(abbrPatterns) || [];
    matches.forEach(m => abbreviations.set(m.toLowerCase(), (abbreviations.get(m.toLowerCase()) || 0) + 1));
  }
  const topAbbreviations = [...abbreviations.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([abbr, count]) => `${abbr} (${count}x)`);
  
  // Punctuation style
  const exclamations = (allText.match(/!+/g) || []).length;
  const questions = (allText.match(/\?+/g) || []).length;
  const ellipsis = (allText.match(/\.{2,}/g) || []).length;
  const multiExcl = (allText.match(/!{2,}/g) || []).length;
  const multiQuestion = (allText.match(/\?{2,}/g) || []).length;
  
  let punctuationStyle = 'normal';
  if (multiExcl > 20 || exclamations > messages.length * 0.3) punctuationStyle = 'expressive — lots of !!! and emphasis';
  else if (ellipsis > 20) punctuationStyle = 'thoughtful — uses ... often (trailing thoughts)';
  else if (questions > messages.length * 0.2) punctuationStyle = 'curious — asks lots of questions';
  
  // Capitalization
  const allCaps = (allText.match(/\b[A-Z]{2,}\b/g) || []).length;
  let capsStyle = 'normal lowercase';
  if (allCaps > 30) capsStyle = 'uses ALL CAPS for emphasis frequently';
  else if (allCaps > 10) capsStyle = 'occasional CAPS for emphasis';
  
  // ════════════════════════════════
  // 6. MESSAGE STRUCTURE
  // ════════════════════════════════
  const avgLen = messages.reduce((a, m) => a + m.length, 0) / messages.length;
  const shortMsgs = messages.filter(m => m.length < 15).length;
  const longMsgs = messages.filter(m => m.length > 100).length;
  const oneWordMsgs = messages.filter(m => !m.includes(' ')).length;
  
  let msgStyle = 'mixed';
  if (shortMsgs > messages.length * 0.6) msgStyle = 'rapid-fire short messages (WhatsApp style texting)';
  else if (longMsgs > messages.length * 0.3) msgStyle = 'detailed long messages (paragraph writer)';
  else msgStyle = 'mix of short and medium messages';
  
  // ════════════════════════════════
  // 7. COMMON PHRASES (2-4 words)
  // ════════════════════════════════
  const phrases = new Map();
  for (const msg of messages) {
    const words = msg.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(w => w.length > 1);
    // Bigrams
    for (let i = 0; i < words.length - 1; i++) {
      const bigram = `${words[i]} ${words[i+1]}`;
      phrases.set(bigram, (phrases.get(bigram) || 0) + 1);
    }
    // Trigrams
    for (let i = 0; i < words.length - 2; i++) {
      const trigram = `${words[i]} ${words[i+1]} ${words[i+2]}`;
      phrases.set(trigram, (phrases.get(trigram) || 0) + 1);
    }
  }
  // Filter out boring phrases AND system message fragments
  const boringWords = new Set(['the', 'and', 'is', 'in', 'to', 'it', 'of', 'for', 'on', 'at', 'hai', 'ka', 'ki', 'ke', 'se', 'ko', 'me', 'mai']);
  const systemPhrases = new Set([
    'this message', 'message was', 'was edited', 'was deleted', 'this message was',
    'message was edited', 'message was deleted', 'you deleted', 'deleted this',
    'you deleted this', 'deleted this message', 'you deleted this message',
    'waiting for', 'this message was edited', 'this message was deleted',
    'media omitted', 'image omitted', 'video omitted', 'audio omitted',
    'sticker omitted', 'document omitted', 'missed voice', 'missed video',
    'voice call', 'video call', 'missed voice call', 'missed video call',
    'security code', 'code changed', 'end to', 'to end', 'end encrypted',
    'are end', 'calls are', 'messages and', 'and calls',
  ]);
  const commonPhrases = [...phrases.entries()]
    .filter(([phrase, count]) => {
      if (count < 3) return false;
      const words = phrase.split(' ');
      if (words.every(w => boringWords.has(w))) return false;
      if (systemPhrases.has(phrase)) return false;
      // Also filter phrases containing system words
      if (phrase.includes('deleted') || phrase.includes('omitted') || phrase.includes('edited') || phrase.includes('encrypted')) return false;
      return true;
    })
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([phrase, count]) => `"${phrase}" (${count}x)`);
  
  // ════════════════════════════════
  // 8. GREETING & FAREWELL PATTERNS
  // ════════════════════════════════
  const greetings = messages.filter(m => m.match(/^(hi|hello|hey|good morning|good night|gm|gn|morning|shubh|suprabhat|namaste|hy|hii|hiii|helloo|hellooo|heyy|heyyy|gooood|gudmorning|gud morning|gud night|gudnight|rise and shine|uth ja|utho|wake up|soja|so ja|so gaye|so gayi)/i));
  const farewells = messages.filter(m => m.match(/(bye|byeee|good night|gn|night|tata|alvida|chalo|chal|ok bye|byee|bbye|nighty|sweet dreams|so ja|so jao|goodnight|tc|take care)$/i));
  
  const greetingExamples = [...new Set(greetings.map(g => g.substring(0, 30)))].slice(0, 5);
  const farewellExamples = [...new Set(farewells.map(f => f.substring(0, 30)))].slice(0, 5);
  
  // ════════════════════════════════
  // 9. AFFECTION LEVEL
  // ════════════════════════════════
  const affectionWords = (allText.match(/\b(love|pyar|miss|jaanu|jaan|baby|babe|kiss|hug|❤|💕|💗|😘|😍|🥰|dil|heart|i love you|love you|luv|lub|lubh)\b/gi) || []).length;
  const affectionRate = (affectionWords / messages.length * 100).toFixed(1);
  
  let affectionLevel = 'low';
  if (affectionRate > 15) affectionLevel = 'very high — extremely romantic and expressive';
  else if (affectionRate > 8) affectionLevel = 'high — regularly romantic';
  else if (affectionRate > 3) affectionLevel = 'moderate — affectionate but not over-the-top';
  else if (affectionRate > 1) affectionLevel = 'subtle — shows love in small gestures';
  
  // ════════════════════════════════
  // 10. UNIQUE SLANG / SIGNATURE WORDS
  // ════════════════════════════════
  const wordFreq = new Map();
  for (const msg of messages) {
    const words = msg.toLowerCase().split(/\s+/);
    words.forEach(w => {
      if (w.length > 2 && !boringWords.has(w)) {
        wordFreq.set(w, (wordFreq.get(w) || 0) + 1);
      }
    });
  }
  const signatureWords = [...wordFreq.entries()]
    .filter(([, count]) => count >= 5)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([word, count]) => `${word} (${count}x)`);
  
  return {
    language, hinglishRatio,
    petNames, 
    topEmojis, emojiPerMsg, emojiPercent, emojiStyle,
    toneScores: sortedTones,
    abbreviations: topAbbreviations,
    punctuationStyle, capsStyle,
    msgStyle, avgLen: Math.round(avgLen),
    shortMsgPercent: Math.round(shortMsgs / messages.length * 100),
    oneWordPercent: Math.round(oneWordMsgs / messages.length * 100),
    commonPhrases,
    greetingExamples, farewellExamples,
    affectionLevel, affectionRate,
    signatureWords,
  };
}

// ═══ MAIN ═══
const filePath = process.argv[2];
if (!filePath) {
  console.log(`
╔═══════════════════════════════════════════════════╗
║  LOCAL WhatsApp Style Extractor v2 (DETAILED)     ║
║  🔒 No data leaves your computer!                ║
╚═══════════════════════════════════════════════════╝

Usage: node local-style-extractor.mjs "path/to/chat.txt"

Config (edit in file):
  YOUR_NAME_HINT = "${YOUR_NAME_HINT}"
  RELATIONSHIP   = "${RELATIONSHIP}"
`);
  process.exit(0);
}

console.log('\n🔒 LOCAL processing — NO data leaves your PC\n');
console.log(`📂 Reading: ${filePath}`);

const senders = parseChat(path.resolve(filePath));
console.log(`\n👥 Chat participants:`);
for (const [name, msgs] of senders) {
  console.log(`   - "${name}": ${msgs.length} messages`);
}

const { userName, contactName, userMsgs } = identifyUser(senders);
console.log(`\n🙋 You: "${userName}" (${userMsgs.length} messages)`);
console.log(`💌 ${RELATIONSHIP}: "${contactName}"`);
console.log('\n🧠 Deep-analyzing your communication style...\n');

const s = analyzeStyle(userMsgs);

// ═══ Generate DETAILED output ═══
const output = `COMMUNICATION STYLE PROFILE for ${RELATIONSHIP} (${contactName}):

📝 LANGUAGE:
- Primary: ${s.language}
- Mix ratio: ${s.hinglishRatio}

💕 PET NAMES & NICKNAMES:
- ${s.petNames.length > 0 ? s.petNames.join(', ') : 'No specific pet names detected — uses direct name or casual address'}

😊 EMOJI USAGE:
- Style: ${s.emojiStyle}
- Frequency: ${s.emojiPerMsg} emojis per message (${s.emojiPercent}% messages have emojis)
- Top emojis: ${s.topEmojis.map(([e, c]) => `${e}(${c}x)`).join(' ')}

🎭 TONE & MOOD:
${s.toneScores.map(([tone, score]) => `- ${tone}: ${'█'.repeat(Math.min(score, 20))} (${score} instances)`).join('\n')}

💗 AFFECTION LEVEL:
- Level: ${s.affectionLevel}
- Rate: ${s.affectionRate}% of messages contain affectionate words

✍️ WRITING STYLE:
- Message structure: ${s.msgStyle}
- Average message length: ${s.avgLen} characters
- Short messages (<15 chars): ${s.shortMsgPercent}%
- One-word messages: ${s.oneWordPercent}%
- Punctuation: ${s.punctuationStyle}
- Capitalization: ${s.capsStyle}

💬 COMMON PHRASES (most used):
${s.commonPhrases.slice(0, 15).map(p => `- ${p}`).join('\n')}

🔤 ABBREVIATIONS & SLANG:
- ${s.abbreviations.length > 0 ? s.abbreviations.join(', ') : 'Standard spelling — no heavy abbreviation use'}

🗣️ SIGNATURE WORDS (most frequently used):
- ${s.signatureWords.slice(0, 15).join(', ')}

👋 GREETING STYLE:
- ${s.greetingExamples.length > 0 ? s.greetingExamples.join(' | ') : 'No specific greeting pattern — starts conversations directly'}

👋 FAREWELL STYLE:
- ${s.farewellExamples.length > 0 ? s.farewellExamples.join(' | ') : 'No specific farewell pattern'}

⚠️ IMPORTANT: ONLY use this style when writing to ${contactName} (${RELATIONSHIP}). For other contacts, use normal/default style.`;

console.log('══════════════════════════════════════════════════');
console.log('  📋 COPY BELOW AND PASTE INTO AGENTICAI CHAT');
console.log('══════════════════════════════════════════════════\n');
console.log(output);
console.log('\n══════════════════════════════════════════════════');
console.log('\n✅ Done! No raw messages saved or sent anywhere.');
console.log('📋 Copy the text above and paste into AgenticAI.\n');
