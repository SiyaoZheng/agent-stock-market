'use strict';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[char]));
const countLabel = (count, singular, plural = `${singular}s`) => `${count} ${Number(count) === 1 ? singular : plural}`;
const safeSourceURL = value => {
  if (typeof value !== 'string') return null;
  try { return ['https:','http:'].includes(new URL(value).protocol) ? value : null; }
  catch { return null; }
};
const socialPlatformLabels = {weibo:'Weibo',xhs:'Xiaohongshu',douyin:'Douyin',kuaishou:'Kuaishou',bilibili:'Bilibili',zhihu:'Zhihu',wechat:'WeChat Channels',toutiao:'Toutiao','baidu-tieba':'Baidu Tieba',x:'X / Twitter',youtube:'YouTube',instagram:'Instagram',tiktok:'TikTok'};
const socialPlatformName = (id, fallback) => socialPlatformLabels[id] || fallback || id || 'Social media';
const colors = ['sage', 'blue', 'amber', 'rose', 'violet'];
const avatar = person => `<span class="avatar ${colors.includes(person.color) ? person.color : 'sage'}" aria-hidden="true">${escapeHTML([...person.name][0] || '?')}</span>`;
const time = value => new Date(value).toLocaleTimeString('en-US', {timeZone:'Asia/Shanghai', hour:'2-digit', minute:'2-digit', hourCycle:'h23'});
const dateTime = value => new Date(value).toLocaleString('en-US', {timeZone:'Asia/Shanghai', month:'long', day:'numeric', hour:'2-digit', minute:'2-digit', hourCycle:'h23'});
const viewport = $('#messagesViewport');
const busy = new Set();
const messageNodes = new Map();
let state = null, online = false, inFlight = null, toastTimer, pollTimer;
let pace = 'natural', filter = 'all', personFilter = null, query = '', replyTo = null;
let peopleKey = '', messagesKey = '', eventsKey = '', boardKey = '', initialMessages = true, knownCount = 0, unread = 0;
let personaDraft = [];
let pollOptions = ['', ''], joiningChain = null, reactionMessage = null, mentionOptions = [], mentionIndex = 0, mentionRange = null, interactionKey = '';
const agentFields = {name:'agentNameInput', role:'agentRoleInput', background:'agentBackgroundInput', rules:'agentRulesInput', memory:'agentMemoryInput'};
const publicFields = {topic:'publicTopic', context:'publicContext', shared_rules:'publicRules'};
const agentDrafts = new Map();
let selectedAgentId = null, currentAgentDetail = null, agentDetailKey = '', agentDetailBusy = false, publicDraft = null;
const preciseTime = value => value ? new Date(value).toLocaleTimeString('en-US', {timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}) : '';
const reactionChoices = [
  {label:'Agree', emoji:String.fromCodePoint(0x1f44d)}, {label:'Disagree', emoji:String.fromCodePoint(0x1f44e)},
  {label:'Laugh', emoji:String.fromCodePoint(0x1f602)}, {label:'Angry', emoji:String.fromCodePoint(0x1f621)},
  {label:'Like', emoji:String.fromCodePoint(0x2764,0xfe0f)}, {label:'Thinking', emoji:String.fromCodePoint(0x1f914)},
];
const activeIds = () => state?.typing_ids ?? (Array.isArray(state?.active) ? state.active : state?.active ? [state.active] : []);
const personName = id => id === 'adrian' ? 'Adrian' : state?.personas.find(person => person.id === id)?.name || id;
const entryText = entry => {
  const text = entry.text || '';
  for (const separator of ['：', ':']) if (text.startsWith(`${entry.name}${separator}`)) return text.slice(entry.name.length + 1).trim();
  return text;
};

function toast(message) {
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4500);
}

function formError(id, message = '') {
  if (!id) { if (message) toast(message); return; }
  $(`#${id}`).textContent = message;
  $(`#${id}`).hidden = !message;
}

async function api(path, body, method = body === undefined ? 'GET' : 'POST') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`/api/${path}`, {
      signal: controller.signal, cache: 'no-store',
      ...(body === undefined ? {} : {method, headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)}),
    });
    let result;
    try { result = await response.json(); }
    catch { throw new Error('The server returned an invalid response. Please try again.'); }
    if (!response.ok) {
      throw new Error(typeof result.detail === 'string' ? result.detail : 'Check that all required fields are complete and within their length limits.');
    }
    return result;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('The connection timed out. Please try again.');
    if (error instanceof TypeError) throw new Error('Cannot connect to the server. Check that it is running.');
    throw error;
  } finally { clearTimeout(timer); }
}

async function refresh(force = false) {
  if (inFlight) { await inFlight; if (!force) return; }
  inFlight = (async () => {
    try {
      const next = await api('state');
      state = {...next, polls:next.polls || [], chains:next.chains || [], events:next.events || []};
      online = true;
      render();
    } catch (error) {
      online = false;
      renderConnection();
      if (!state) {
        $('#topicTitle').textContent = 'Waiting for connection';
        $('#topicContext').textContent = 'Start the local server to load members, the topic, and saved messages.';
        $('#messages').innerHTML = '<div class="empty-board"><span class="empty-mark" aria-hidden="true">↳</span><h3>Cannot connect to chat</h3><p>Check that the local server is running.<br>This page reconnects automatically.</p><button class="secondary-button" data-retry>Reconnect</button></div>';
      }
    }
  })();
  try { await inFlight; } finally { inFlight = null; }
}

async function action(path, body = {}, errorId = null, method = 'POST') {
  if (busy.has(path)) return null;
  busy.add(path);
  formError(errorId);
  updateControls();
  try {
    const result = await api(path, body, method);
    await refresh(true);
    return result;
  } catch (error) {
    formError(errorId, error.message);
    return null;
  } finally {
    busy.delete(path);
    updateControls();
  }
}

function renderConnection() {
  $('#connectionBanner').hidden = online;
  $('#connectionDot').classList.toggle('offline', !online || !state?.connection.ready);
  if (!online) {
    $('#liveText').textContent = 'Reconnecting';
    $('#liveDot').className = 'status-dot offline';
    $('#runBadge').textContent = 'Disconnected';
    $('#runBadge').classList.remove('running');
  }
  updateControls();
  window.marketUI?.update(state,online);
  window.socialSearchUI?.update(state,online);
}

function updateControls() {
  const running = !!state?.running;
  const changing = ['start', 'stop', 'setup', 'reset', 'connection'].some(path => busy.has(path));
  const locked = !state || !online || running || changing;
  for (const id of ['editPeopleButton', 'connectionButton', 'resetButton']) $(`#${id}`).disabled = locked;
  $('#editTopicButton').disabled = !state || !online;
  $('#publicInfoButton').disabled = !state || !online;
  $('#startButton').disabled = locked;
  $('#startText').textContent = busy.has('start') ? 'Starting…' : running ? 'Conversation running' : state?.messages.length ? 'Resume' : 'Start';
  $('#pauseButton').hidden = !running;
  $('#pauseButton').disabled = !online || busy.has('stop') || !!state?.stopping;
  $('#pauseButton').textContent = state?.stopping || busy.has('stop') ? 'Pausing…' : 'Pause';
  $('#paceSelect').disabled = !state || !online || busy.has('pace');
  $('#messageInput').disabled = !state || !online;
  $('#sendButton').disabled = !state || !online || busy.has('message') || !$('#messageInput').value.trim();
  $('#sendButton').innerHTML = busy.has('message') ? 'Sending…' : 'Send <span aria-hidden="true">↑</span>';
  $('#saveSetupButton').disabled = locked;
  $('#saveSetupButton').textContent = busy.has('setup') ? 'Saving…' : state?.scenario === 'market' ? 'Save and reset market' : 'Save and create';
  $('#saveConnectionButton').disabled = locked;
  $('#confirmResetButton').disabled = locked;
  $('#addPersonButton').disabled = personaDraft.length >= 8 || busy.has('setup');
  for (const id of ['mentionButton','newPollButton','newChainButton']) $(`#${id}`).disabled = !state || !online;
  $('#createPollButton').disabled = !state || !online || busy.has('polls');
  $('#createChainButton').disabled = !state || !online || busy.has('chains');
  $('#joinChainButton').disabled = !state || !online || (joiningChain && busy.has(`chains/${joiningChain}/join`));
  $$('[data-vote-poll]').forEach(button => { button.disabled = !online || busy.has(`polls/${button.dataset.votePoll}/vote`); });
  $$('[data-reaction-emoji], [data-react]').forEach(button => { button.disabled = !online || busy.has('reactions'); });
  const draft = agentDrafts.get(selectedAgentId);
  const savingAgent = selectedAgentId && busy.has(`agents/${selectedAgentId}`);
  $('#saveAgentButton').disabled = !online || savingAgent || !draft || !draft.dirty.size;
  $('#saveAgentButton').textContent = savingAgent ? 'Saving…' : 'Save changes';
  Object.values(agentFields).forEach(id => { $(`#${id}`).disabled = !!savingAgent; });
  $('#savePublicButton').disabled = !online || busy.has('context') || !publicDraft?.dirty.size;
  Object.values(publicFields).forEach(id => { $(`#${id}`).disabled = busy.has('context'); });
}

function renderPeople() {
  const key = JSON.stringify([state.personas, activeIds(), state.running]);
  if (key === peopleKey) return;
  peopleKey = key;
  const focusedPerson = $('#peopleList').contains(document.activeElement) ? document.activeElement.dataset.person : null;
  $('#peopleList').innerHTML = state.personas.map(person => {
    const active = state.running && activeIds().includes(person.id);
    return `<button class="person-card ${active ? 'is-active' : ''}" data-person="${escapeHTML(person.id)}" aria-haspopup="dialog" aria-label="View profile for ${escapeHTML(person.name)}">${avatar(person)}<span class="person-copy"><span class="person-name">${escapeHTML(person.name)}<span class="person-state">${active ? 'Typing' : '↗'}</span></span><span class="person-role">${escapeHTML(person.role)}</span><span class="person-snippet">${escapeHTML(person.background)}</span></span></button>`;
  }).join('');
  if (focusedPerson) $$('[data-person]').find(button => button.dataset.person === focusedPerson)?.focus({preventScroll:true});
  $('#peopleCount').textContent = state.personas.length;
  $('#mobilePeopleCount').textContent = state.personas.length;
  $('#groupCount').textContent = `· ${state.personas.length + 1} members`;
}

function richText(body) {
  const names = [...(state?.personas || []), {id:'adrian',name:'Adrian'}, {id:'everyone',name:'everyone'}].sort((a,b) => b.name.length - a.name.length);
  const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`@(${names.map(person => escapeRegExp(person.name)).join('|')})(?![\\p{L}\\p{N}_])`, 'giu');
  let result = '', offset = 0;
  for (const match of String(body || '').matchAll(pattern)) {
    result += escapeHTML(body.slice(offset, match.index));
    const person = names.find(item => item.name.toLocaleLowerCase() === match[1].toLocaleLowerCase());
    result += person.id === 'everyone' || person.id === 'adrian'
      ? `<span class="mention ${person.id === 'adrian' ? 'me' : ''}">${escapeHTML(match[0])}</span>`
      : `<button class="mention" data-person="${escapeHTML(person.id)}">${escapeHTML(match[0])}</button>`;
    offset = match.index + match[0].length;
  }
  return result + escapeHTML(String(body || '').slice(offset));
}

function pollCard(poll) {
  const total = Object.keys(poll.votes).length;
  const selected = poll.votes.adrian;
  return `<div class="interaction-card"><span class="type-label">Poll · by ${escapeHTML(personName(poll.creator_id))}</span><h3>${escapeHTML(poll.question)}</h3><div class="poll-options">${poll.options.map((option,index) => {
    const count = poll.counts[index] || 0;
    const share = total ? Math.round(count / total * 100) : 0;
    const voters = Object.entries(poll.votes).filter(([,choice]) => choice === index).map(([id]) => personName(id)).join(', ');
    return `<button class="poll-option ${selected === index ? 'selected' : ''}" data-vote-poll="${escapeHTML(poll.id)}" data-option="${index}" aria-pressed="${selected === index}" aria-label="Vote for ${escapeHTML(option)}, ${countLabel(count,'vote')}${selected === index ? ', selected' : ''}" title="${escapeHTML(voters || 'No votes yet')}" style="--vote-share:${share}%"><span class="option-fill" aria-hidden="true"></span><span class="option-marker" aria-hidden="true">${selected === index ? '✓' : ''}</span><span class="option-text">${escapeHTML(option)}</span><span class="option-count">${countLabel(count,'vote')}</span></button>`;
  }).join('')}</div><div class="card-meta"><span>${total} voted</span><span>${selected !== undefined ? 'Vote saved · Select another option to change it' : 'Select an option to vote'}</span></div></div>`;
}

function chainCard(chain) {
  const joined = chain.entries.some(entry => entry.actor_id === 'adrian');
  return `<div class="interaction-card"><span class="type-label">Sign-up list · by ${escapeHTML(personName(chain.creator_id))}</span><h3>${escapeHTML(chain.title)}</h3>${chain.prompt ? `<p class="card-description">${escapeHTML(chain.prompt)}</p>` : ''}<div class="chain-preview">${chain.entries.slice(0,3).map((entry,index) => `<div class="chain-preview-item"><span>${index+1}.</span><p><strong>${escapeHTML(entry.name)}</strong>${escapeHTML(entryText(entry))}</p></div>`).join('')}</div>${!chain.entries.length ? '<p class="chain-empty">Be the first to add an entry.</p>' : ''}<button class="card-action" data-join-chain="${escapeHTML(chain.id)}">${joined ? 'View / edit my entry' : 'Add my entry'}${chain.entries.length > 3 ? ` · View all ${chain.entries.length} entries` : ''}</button><div class="card-meta"><span>${chain.entries.length} joined</span><span>${joined ? 'You joined' : 'Everyone is welcome'}</span></div></div>`;
}

function reactionsMarkup(message) {
  return Object.entries(message.reactions || {}).filter(([,people]) => people.length).map(([emoji,people]) => `<button class="reaction-pill ${people.includes('adrian') ? 'selected' : ''}" data-reaction-message="${message.id}" data-reaction-emoji="${escapeHTML(emoji)}" aria-pressed="${people.includes('adrian')}" title="${escapeHTML(people.map(personName).join(', '))}" aria-label="${escapeHTML(emoji)}, ${countLabel(people.length,'reaction')}${people.includes('adrian') ? ', select to remove your reaction' : ''}">${escapeHTML(emoji)} <span>${people.length}</span></button>`).join('');
}

function sourceCard(message) {
  const source = message.source;
  if (!source || typeof source !== 'object') return '';
  const url = safeSourceURL(source.url), title = source.title || 'Shared search result';
  const author = typeof source.author === 'object' && source.author ? source.author.name || source.author.nickname || source.author.username || '' : source.author || '';
  const published = source.published_at ? new Date(typeof source.published_at === 'number' && source.published_at < 1e12 ? source.published_at * 1000 : source.published_at) : null;
  const publishedLabel = published && !Number.isNaN(published.getTime()) ? published.toLocaleDateString('en-US',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}) : '';
  return `<div class="interaction-card message-source"><span class="type-label">${escapeHTML(socialPlatformName(source.platform,source.platform_name))} · Shared source</span><h3>${url ? `<a href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(title)}</a>` : escapeHTML(title)}</h3>${source.text ? `<p class="source-snippet">${escapeHTML(source.text)}</p>` : ''}${author || publishedLabel ? `<div class="source-byline">${author ? `<span>${escapeHTML(author)}</span>` : ''}${publishedLabel ? `<time>${publishedLabel}</time>` : ''}</div>` : ''}<div class="source-actions">${url ? `<a href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">Open original ↗</a>` : ''}${source.search_id ? `<button type="button" data-shared-search="${escapeHTML(source.search_id)}" data-search-actor="${escapeHTML(message.author_id)}">View search</button>` : ''}</div></div>`;
}

function searchText(message) {
  const poll = state.polls.find(item => item.id === message.poll_id);
  const chain = state.chains.find(item => item.id === message.chain_id);
  return [message.name, message.role, message.body, message.source?.title, message.source?.text, message.source?.platform_name, poll?.question, ...(poll?.options || []), chain?.title, chain?.prompt, ...(chain?.entries.map(entry => `${entry.name} ${entry.text}`) || [])].filter(Boolean).join(' ').toLocaleLowerCase();
}

function nearBottom() { return viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop < 70; }
function updateUnread() {
  if (nearBottom()) unread = 0;
  $('#newMessagesButton').hidden = nearBottom() || !state?.messages.length;
  $('#newMessagesButton').innerHTML = `${unread ? `${countLabel(unread,'new message')}` : 'Latest messages'} <span aria-hidden="true">↓</span>`;
}
function scrollToLatest() {
  viewport.scrollTop = viewport.scrollHeight;
  unread = 0;
  updateUnread();
}

function renderMessages(resetPosition = false) {
  if (!state) return;
  const key = JSON.stringify([state.messages, state.polls, state.chains, filter, personFilter, query]);
  if (key === messagesKey) return;
  messagesKey = key;
  const follow = initialMessages || (!resetPosition && nearBottom());
  const added = Math.max(0, state.messages.length - knownCount);
  const byId = new Map(state.messages.map(message => [message.id, message]));
  const replyCounts = new Map();
  state.messages.forEach(message => { if (message.reply_to != null) replyCounts.set(message.reply_to, (replyCounts.get(message.reply_to) || 0) + 1); });
  const matching = state.messages.filter(message =>
    (filter === 'all' || (filter === 'mentions' && message.mentions?.includes('adrian')) || (filter === 'activities' && ['poll','chain'].includes(message.type))) &&
    (!personFilter || message.author_id === personFilter) &&
    (!query || searchText(message).includes(query.toLocaleLowerCase()))
  );
  const desired = [];
  let lastTime = null;
  for (const message of matching) {
    if (!lastTime || new Date(message.time) - new Date(lastTime) >= 300000) {
      const dividerKey = `time-${message.id}`;
      let divider = messageNodes.get(dividerKey);
      if (!divider) {
        divider = document.createElement('div');
        divider.className = 'time-divider';
        divider.textContent = dateTime(message.time);
        messageNodes.set(dividerKey, divider);
      }
      desired.push(divider);
    }
    lastTime = message.time;
    const nodeKey = `message-${message.id}`;
    let node = messageNodes.get(nodeKey);
    if (!node) {
      node = document.createElement('article');
      node.id = nodeKey;
      node.tabIndex = -1;
      node.className = `message-card${message.kind === 'human' ? ' own-message' : ''}${message.mentions?.includes('adrian') ? ' mentioned' : ''}`;
      if (!initialMessages && message.id > knownCount) node.classList.add('new-entry');
      messageNodes.set(nodeKey, node);
    }
    const parent = byId.get(message.reply_to);
    const responseCount = replyCounts.get(message.id) || 0;
    const poll = state.polls.find(item => item.id === message.poll_id);
    const chain = state.chains.find(item => item.id === message.chain_id);
    const contentKey = JSON.stringify([message, parent?.body, parent?.name, responseCount, poll, chain]);
    if (node.dataset.contentKey !== contentKey) {
      node.dataset.contentKey = contentKey;
      const isResident = state.personas.some(person => person.id === message.author_id);
      const author = isResident ? `<button class="author-button" data-person="${escapeHTML(message.author_id)}" aria-label="View profile for ${escapeHTML(message.name)}">${escapeHTML(message.name)}</button>` : `<strong class="author-button">${escapeHTML(message.name)}</strong>`;
      const quote = parent ? `<button class="reply-quote" data-jump="${parent.id}" aria-label="View original message ${parent.id} from ${escapeHTML(parent.name)}"><strong>Reply ${escapeHTML(parent.name)} · #${parent.id}<span aria-hidden="true">↗</span></strong><span>${escapeHTML(parent.body)}</span></button>` : '';
      const content = poll ? pollCard(poll) : chain ? chainCard(chain) : `${message.body ? `<p class="message-body">${richText(message.body)}</p>` : ''}${sourceCard(message)}`;
      node.innerHTML = `<div class="message-header">${avatar(message)}<div class="message-author">${author}<small>${escapeHTML(message.role)}</small></div><div class="message-stamp"><time datetime="${escapeHTML(message.time)}">${time(message.time)}</time></div></div>${quote}${content}<div class="message-reactions">${reactionsMarkup(message)}</div><div class="message-bottom"><button class="reply-button" data-reply="${message.id}" aria-label="Reply to message ${message.id} from ${escapeHTML(message.name)}">↳ Reply</button><button class="reply-button" data-react="${message.id}" aria-label="React to message ${message.id}">＋ React</button>${responseCount ? `<span class="reply-count">${countLabel(responseCount,'reply','replies')}</span>` : ''}<span class="message-number">#${String(message.id).padStart(2,'0')}</span></div>`;
    }
    desired.push(node);
  }
  if (!desired.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-board';
    const narrowed = query || personFilter || filter !== 'all';
    const heading = filter === 'mentions' && !query ? 'Mentions of you will appear here' : filter === 'activities' && !query ? 'Decide together' : narrowed ? 'No matching messages' : 'Start the conversation';
    const detail = filter === 'activities' && !query ? 'Use Poll or Sign-up below to start a group activity.' : narrowed ? 'Return to the chat to see the full conversation.' : 'Start the conversation to see how traders read the market.<br>Or send a message to introduce yourself.';
    empty.innerHTML = `<span class="empty-mark" aria-hidden="true">↳</span><h3>${heading}</h3><p>${detail}</p>${narrowed ? '<button class="secondary-button" data-clear-filters>Back to chat</button>' : ''}`;
    desired.push(empty);
  }
  // Keep existing message elements in place so polling does not replace a reader's selection.
  const container = $('#messages');
  const desiredSet = new Set(desired);
  [...container.children].forEach(child => { if (!desiredSet.has(child)) child.remove(); });
  desired.forEach((node, index) => { if (container.children[index] !== node) container.insertBefore(node, container.children[index] || null); });
  for (const [nodeKey] of messageNodes) {
    if (nodeKey.startsWith('time-') && !desiredSet.has(messageNodes.get(nodeKey))) messageNodes.delete(nodeKey);
  }
  if (!initialMessages && added) {
    $('#screenReaderStatus').textContent = `${countLabel(added,'new message')}, ${state.messages.length} total.`;
    if (!follow) unread += added;
  }
  knownCount = state.messages.length;
  initialMessages = false;
  if (resetPosition) { viewport.scrollTop = 0; unread = 0; }
  else if (follow) scrollToLatest();
  updateUnread();
  const selectedPerson = state.personas.find(person => person.id === personFilter);
  $('#filterSummary').hidden = !personFilter && !query;
  $('#filterSummaryText').textContent = `${selectedPerson ? `Messages from ${selectedPerson.name} · ` : ''}${query ? `Search: “${query}” · ` : ''}${countLabel(matching.length,'message')}`;
  $$('[data-filter]').forEach(button => { const selected = button.dataset.filter === filter; button.classList.toggle('active', selected); button.setAttribute('aria-pressed', String(selected)); });
}

function render() {
  if (boardKey !== state.created_at) {
    if (boardKey) { clearReply(); personFilter = null; query = ''; filter = 'all'; $('#searchInput').value = ''; agentDrafts.clear(); publicDraft = null; currentAgentDetail = null; agentDetailKey = ''; }
    if (selectedAgentId && !state.personas.some(person => person.id === selectedAgentId)) { $('#personDialog').close(); selectedAgentId = null; }
    boardKey = state.created_at;
    messagesKey = ''; peopleKey = ''; eventsKey = ''; interactionKey = ''; initialMessages = true; knownCount = 0; unread = 0;
    messageNodes.clear();
    $('#messages').replaceChildren();
  }
  const marketScenario = state.scenario === 'market';
  $('#editPeopleButton').textContent = marketScenario ? '＋ New market' : '＋ New conversation';
  $('#resetButton').textContent = marketScenario ? 'Reset market' : 'New conversation';
  $('#setupHeading').textContent = marketScenario ? 'Set up a new market' : 'Set topic and members';
  $('#setupConsequence').textContent = marketScenario ? 'Saving resets accounts, orders, trades, and chat history.' : 'Saving starts a new conversation.';
  $('#topicTitle').textContent = state.topic;
  $('#topicContext').textContent = state.context;
  updateContextToggle();
  renderPeople();
  renderMessages();
  const replyCount = state.messages.filter(message => message.reply_to != null).length;
  $('#messageCount').textContent = $('#statMessages').textContent = state.messages.length;
  $('#statReplies').textContent = replyCount;
  $('#mentionCount').textContent = state.messages.filter(message => message.mentions?.includes('adrian')).length;
  $('#interactionCount').textContent = state.polls.length + state.chains.length;
  $('#statParticipants').textContent = new Set(state.messages.map(message => message.author_id)).size;
  $('#boardSummary').textContent = `${state.personas.length + 1} members · ${state.messages.length} messages`;
  const typing = activeIds().map(personName);
  $('#liveText').textContent = state.stopping ? 'Pausing conversation…' : state.running && typing.length ? `${typing.slice(0,2).join(', ')}${typing.length > 2 ? ` and ${typing.length-2} more` : ''} ${typing.length === 1 ? 'is' : 'are'} typing…` : state.error ? 'Conversation paused. Ready to retry.' : state.running ? 'Conversation running. Join at any time.' : state.messages.length ? 'Agents paused. You can still send messages.' : 'The room is ready. Say hello.';
  $('#liveRound').textContent = state.running ? 'Open conversation' : 'Visible to everyone';
  $('#liveDot').className = `status-dot${state.running ? ' running' : ''}`;
  $('#runBadge').textContent = state.running ? state.stopping ? 'Pausing' : 'Running' : state.messages.length || state.error ? 'Paused' : 'Ready';
  $('#runBadge').classList.toggle('running', state.running);
  $('#runStatus').textContent = state.running ? `${state.personas.length} members in conversation` : 'Resume the conversation at any time';
  if (!busy.has('pace') && state.pace) { pace = state.pace; $('#paceSelect').value = pace; }
  $('#activityTag').textContent = state.running ? 'Running' : 'Recent activity';
  $('#modelName').textContent = state.connection.model === 'deepseek-flash' ? 'DeepSeek Flash' : state.connection.model;
  $('#thinkingLabel').textContent = state.connection.thinking === 'disabled' ? 'Thinking off' : 'Thinking on';
  $('#errorBanner').hidden = !state.error;
  $('#errorBanner').textContent = state.error || '';
  const recentEvents = state.events.slice(-5).reverse();
  const nextEventsKey = JSON.stringify(recentEvents);
  if (eventsKey !== nextEventsKey) {
    eventsKey = nextEventsKey;
    $('#activityList').innerHTML = recentEvents.map(event => `<div class="activity-entry"><span class="activity-dot" aria-hidden="true"></span><div>${escapeHTML(event.text)}<small>${time(event.time)}</small></div></div>`).join('');
  }
  renderInteractions();
  if ($('#joinChainDialog').open) renderChainEntries();
  if ($('#personDialog').open && selectedAgentId) {
    const privateState = state.agent_states?.[selectedAgentId];
    if (privateState) renderAgentObservation(privateState);
    loadAgentDetail();
  }
  if ($('#publicDialog').open) syncPublicDraft();
  if (replyTo != null && !state.messages.some(message => message.id === replyTo)) clearReply();
  renderConnection();
}

function renderInteractions() {
  const key = JSON.stringify([state.polls, state.chains]);
  if (key === interactionKey) return;
  interactionKey = key;
  const interactions = [...state.polls.map(poll => ({kind:'poll', title:poll.question, message:poll.message_id, time:poll.created_at, detail:`${Object.keys(poll.votes).length} voted`})), ...state.chains.map(chain => ({kind:'chain', title:chain.title, message:chain.message_id, time:chain.created_at, detail:`${chain.entries.length} joined`}))].sort((a,b) => new Date(b.time) - new Date(a.time));
  $('#activeInteractionCount').textContent = interactions.length;
  $('#interactionList').innerHTML = interactions.length ? interactions.slice(0,4).map(item => `<button class="interaction-item" data-jump="${item.message}"><span class="type-icon" aria-hidden="true">${item.kind === 'poll' ? '≡' : '↳'}</span><span><strong>${escapeHTML(item.title)}</strong><small>${item.kind === 'poll' ? 'Poll' : 'Sign-up'} · ${item.detail}</small></span></button>`).join('') : '<p class="panel-intro">Start a poll or a sign-up list.</p>';
}

function updateContextToggle() {
  const paragraph = $('#topicContext');
  const expanded = $('#contextToggle').getAttribute('aria-expanded') === 'true';
  $('#contextToggle').hidden = !expanded && paragraph.scrollHeight <= paragraph.clientHeight + 1;
}

function clearReply() { replyTo = null; $('#replyComposer').hidden = true; }
function clearFilters() {
  filter = 'all'; personFilter = null; query = ''; $('#searchInput').value = '';
  renderMessages(true);
}
function closeDrawers() { for (const id of ['peopleDrawer','controlsDrawer']) if ($(`#${id}`).open) $(`#${id}`).close(); }
function openDrawer(dialogId, panelId, mountId) {
  closeDrawers();
  const dialog = $(`#${dialogId}`);
  dialog.querySelector('[data-drawer-content]').append($(`#${panelId}`));
  dialog.addEventListener('close', () => { $(`#${mountId}`).append($(`#${panelId}`)); }, {once:true});
  dialog.showModal();
}

function showPerson(id) {
  const person = state?.personas.find(item => item.id === id);
  if (!person) return;
  closeDrawers();
  selectedAgentId = id; currentAgentDetail = null; agentDetailKey = '';
  $('#personDetail').innerHTML = `<div class="person-detail-head">${avatar(person)}<div><h2 id="personName">${escapeHTML(person.name)}</h2><small>${escapeHTML(person.role)}</small></div></div>`;
  formError('agentError');
  selectPersonTab('observe');
  const privateState = state.agent_states?.[id] || {};
  renderAgentObservation(privateState);
  syncAgentDraft({persona:person, ...privateState});
  $('#agentHistory').innerHTML = '<p class="loading-copy">Loading recent activity…</p>';
  $('#effectiveInstructions').textContent = '';
  $('#preparedInstructions').textContent = '';
  $('#instructionsLoadedAt').textContent = 'Loading configuration history…';
  $('#loadedPersona').textContent = 'Loading active persona…';
  if (!$('#personDialog').open) $('#personDialog').showModal();
  loadAgentDetail(true);
  window.marketUI?.renderAgentAccount();
  window.socialSearchUI?.renderAgent();
}

function selectPersonTab(name) {
  $$('[data-person-tab]').forEach(button => { const selected = button.dataset.personTab === name; button.classList.toggle('selected',selected); button.setAttribute('aria-selected',String(selected)); button.tabIndex = selected ? 0 : -1; });
  $$('[data-person-panel]').forEach(panel => { panel.hidden = panel.dataset.personPanel !== name; });
}
function makeDraft(values) { return {values:{...values}, baseline:{...values}, dirty:new Set()}; }
function syncDraftFields(draft, values, fields, replace = false) {
  for (const [name,id] of Object.entries(fields)) {
    if (replace || (!draft.dirty.has(name) && document.activeElement !== $(`#${id}`))) {
      draft.values[name] = values[name] ?? '';
      draft.baseline[name] = values[name] ?? '';
      if ($(`#${id}`).value !== draft.values[name]) $(`#${id}`).value = draft.values[name];
      draft.dirty.delete(name);
    } else if (document.activeElement !== $(`#${id}`) && $(`#${id}`).value !== draft.values[name]) {
      $(`#${id}`).value = draft.values[name];
    }
  }
}
function syncAgentDraft(detail, replace = false) {
  if (!selectedAgentId || !detail.persona) return;
  const values = {name:detail.persona.name, role:detail.persona.role, background:detail.persona.background, rules:detail.rules || '', memory:detail.memory || ''};
  let draft = agentDrafts.get(selectedAgentId);
  if (!draft) { draft = makeDraft(values); agentDrafts.set(selectedAgentId,draft); }
  syncDraftFields(draft,values,agentFields,replace);
  $('#agentSaveStatus').textContent = draft.dirty.size ? `${countLabel(draft.dirty.size,'unsaved change')}` : 'Settings are up to date.';
  updateControls();
}
function renderAgentObservation(detail) {
  const typing = activeIds().includes(selectedAgentId);
  $('#agentStatus').textContent = typing ? 'Preparing a message' : state?.running ? 'Conversation running' : 'Paused';
  $('#agentStatusDot').className = `status-dot${typing ? ' running' : ''}`;
  $('#agentUpdated').textContent = preciseTime(detail.updated_at);
  $('#thoughtSummary').textContent = detail.thought_summary || 'Waiting for the first activity summary.';
  $('#agentIntention').textContent = detail.intention || 'Waiting for the next action';
  $('#agentMood').textContent = detail.mood || 'Not yet reported';
  const pending = typeof detail.loaded_epoch !== 'number' || detail.loaded_epoch !== detail.epoch;
  const text = pending ? `Settings saved · waiting to load (version ${detail.epoch ?? 0})` : `Current settings loaded · version ${detail.epoch}${detail.loaded_at ? ` · ${preciseTime(detail.loaded_at)}` : ''}`;
  for (const id of ['agentLoadedState','agentFormLoadedState']) { $(`#${id}`).textContent = text; $(`#${id}`).classList.toggle('pending',pending); }
  const readIds = detail.last_read_message_ids || [];
  $('#agentReadSummary').textContent = `${countLabel(readIds.length,'message')} read recently${detail.last_read_at ? ` · ${preciseTime(detail.last_read_at)}` : ''}`;
  $('#agentReadMessages').innerHTML = readIds.map(id => `<button data-jump="${Number(id)}">#${Number(id)}</button>`).join('');
}
async function loadAgentDetail(force = false) {
  const id = selectedAgentId;
  if (!id || !online || agentDetailBusy || busy.has(`agents/${id}`)) return;
  const key = `${id}:${state.private_revision ?? 0}:${state.revision ?? 0}`;
  if (!force && key === agentDetailKey) return;
  agentDetailBusy = true;
  try {
    const detail = await api(`agents/${encodeURIComponent(id)}`);
    if (selectedAgentId !== id) return;
    currentAgentDetail = detail; agentDetailKey = key;
    formError('agentError');
    renderAgentObservation(detail); syncAgentDraft(detail);
    const person = detail.persona;
    $('#personDetail').innerHTML = `<div class="person-detail-head">${avatar(person)}<div><h2 id="personName">${escapeHTML(person.name)}</h2><small>${escapeHTML(person.role)}</small></div></div>`;
    $('#effectiveInstructions').textContent = detail.loaded_instructions || 'Waiting for the agent to load its settings.';
    $('#preparedInstructions').textContent = detail.effective_instructions || '';
    $('#instructionsLoadedAt').textContent = detail.loaded_at ? `Last loaded · ${preciseTime(detail.loaded_at)} · Version ${detail.loaded_epoch}` : 'Not loaded yet';
    const loaded = detail.loaded_persona;
    $('#loadedPersona').textContent = loaded ? `${loaded.name} · ${loaded.role}\n${loaded.background}` : 'Waiting for the agent to load its persona.';
    $('#agentHistory').innerHTML = detail.history?.length ? [...detail.history].reverse().map(entry => `<article class="agent-history-item"><div class="history-meta"><time>${preciseTime(entry.time)}</time><span>${escapeHTML(entry.mood || '')}</span></div><p>${escapeHTML(entry.summary || '')}</p><small>${escapeHTML(entry.intention || entry.action || '')}</small></article>`).join('') : '<p class="loading-copy">Agent activity will appear here.</p>';
  } catch (error) { if (selectedAgentId === id) formError('agentError',error.message); }
  finally { agentDetailBusy = false; }
}
function syncPublicDraft(replace = false) {
  if (!state) return;
  const values = {topic:state.topic, context:state.context, shared_rules:state.shared_rules || ''};
  if (!publicDraft) publicDraft = makeDraft(values);
  syncDraftFields(publicDraft,values,publicFields,replace);
  $('#publicSaveStatus').textContent = publicDraft.dirty.size ? `${countLabel(publicDraft.dirty.size,'unsaved change')}` : 'Shared settings are up to date.';
  const loaded = state.personas.filter(person => { const detail = state.agent_states?.[person.id]; return detail && typeof detail.loaded_epoch === 'number' && detail.loaded_epoch === detail.epoch; });
  $('#publicLoadedState').textContent = loaded.length === state.personas.length ? `All ${loaded.length} members have loaded the current settings` : `${loaded.length} / ${state.personas.length} members have loaded the current settings`;
  $('#publicLoadedState').classList.toggle('pending',loaded.length !== state.personas.length);
  updateControls();
}
function openPublicSettings() {
  if (!state) return;
  closeDrawers(); formError('publicError'); syncPublicDraft();
  $('#publicDialog').showModal();
}

function renderEditors() {
  $('#editorCount').textContent = personaDraft.length;
  $('#personaEditors').innerHTML = personaDraft.map((person,index) => `<section class="persona-editor" data-editor="${index}"><div class="editor-heading">${avatar(person)}<strong>Member ${index + 1}</strong><button type="button" class="quiet-button" data-remove-person="${index}" ${personaDraft.length <= 2 ? 'disabled' : ''} aria-label="Remove ${escapeHTML(person.name || `Member ${index+1}`)}">Remove</button></div><div class="editor-row"><label>Name<input name="name" value="${escapeHTML(person.name)}" maxlength="30" required></label><label>Role<input name="role" value="${escapeHTML(person.role)}" maxlength="60" required></label></div><label>Background<textarea name="background" rows="3" minlength="5" maxlength="1500" required>${escapeHTML(person.background)}</textarea></label></section>`).join('');
  updateControls();
}
function collectDraft() {
  personaDraft = $$('[data-editor]').map(element => ({...personaDraft[Number(element.dataset.editor)], name:element.querySelector('[name="name"]').value.trim(), role:element.querySelector('[name="role"]').value.trim(), background:element.querySelector('[name="background"]').value.trim()}));
}
function openSetup() {
  if (!state || state.running) return;
  closeDrawers();
  personaDraft = state.personas.map(person => ({...person}));
  $('#setupTopic').value = state.topic;
  $('#setupContext').value = state.context;
  formError('setupError');
  renderEditors();
  $('#setupDialog').showModal();
}
function openConnection() {
  if (!state || state.running) return;
  closeDrawers();
  $('#connectionStatus').textContent = state.connection.ready ? 'An API key is configured.' : 'Enter an API key.';
  $('#connectionModel').textContent = state.connection.model;
  $('#apiKeyInput').value = '';
  formError('connectionError');
  $('#connectionDialog').showModal();
}

function hideMentions() {
  $('#mentionPicker').hidden = true;
  $('#messageInput').setAttribute('aria-expanded', 'false');
  $('#messageInput').removeAttribute('aria-activedescendant');
  mentionRange = null;
}
function renderMentionPicker() {
  $('#mentionPicker').innerHTML = mentionOptions.map((person,index) => `<button type="button" role="option" aria-selected="${index === mentionIndex}" id="mention-option-${index}" class="mention-option ${index === mentionIndex ? 'selected' : ''}" data-mention-index="${index}">${avatar(person)}<span><strong>${escapeHTML(person.name)}</strong><small>${escapeHTML(person.role)}</small></span></button>`).join('');
  $('#mentionPicker').hidden = false;
  $('#messageInput').setAttribute('aria-expanded', 'true');
  $('#messageInput').setAttribute('aria-activedescendant', `mention-option-${mentionIndex}`);
  document.getElementById(`mention-option-${mentionIndex}`)?.scrollIntoView({block:'nearest'});
}
function updateMentions() {
  if (!state) return;
  const input = $('#messageInput');
  const cursor = input.selectionStart;
  const match = input.value.slice(0,cursor).match(/(?:^|[\s,.!?;:])@([^\r\n@,.!?;:]{0,60})$/u);
  if (!match) { hideMentions(); return; }
  const people = [...state.personas, {id:'everyone',name:'everyone',role:'All members',color:'sage'}];
  mentionOptions = people.filter(person => person.name.toLocaleLowerCase().includes(match[1].toLocaleLowerCase()));
  if (!mentionOptions.length) { hideMentions(); return; }
  mentionIndex = 0;
  mentionRange = {start:cursor - match[1].length - 1, end:cursor};
  renderMentionPicker();
}
function insertMention(index) {
  const person = mentionOptions[index];
  if (!person || !mentionRange) return;
  const input = $('#messageInput');
  input.setRangeText(`@${person.name} `, mentionRange.start, mentionRange.end, 'end');
  hideMentions(); updateComposer(); input.focus();
}
function renderPollOptions() {
  $('#pollOptions').innerHTML = pollOptions.map((option,index) => `<div class="option-editor"><input aria-label="Poll option ${index+1}" value="${escapeHTML(option)}" placeholder="Option ${index+1}" required maxlength="80"><button class="icon-button" type="button" data-remove-option="${index}" aria-label="RemovePoll option ${index+1}" ${pollOptions.length <= 2 ? 'disabled' : ''}>×</button></div>`).join('');
  $('#addPollOption').disabled = pollOptions.length >= 6;
}
function openPoll() {
  if (!state || !online) return;
  closeDrawers();
  pollOptions = ['',''];
  $('#pollQuestion').value = '';
  formError('pollError'); renderPollOptions();
  $('#pollDialog').showModal();
}
function openChain() {
  if (!state || !online) return;
  closeDrawers();
  $('#chainTitle').value = ''; $('#chainDescription').value = '';
  formError('chainError'); $('#chainDialog').showModal();
}
function renderChainEntries() {
  const chain = state?.chains.find(item => item.id === joiningChain);
  if (!chain) return;
  $('#joinChainHeading').textContent = chain.title;
  $('#joinChainDescription').textContent = chain.prompt;
  $('#chainEntries').innerHTML = chain.entries.length ? chain.entries.map((entry,index) => {
    const person = state.personas.find(person => person.id === entry.actor_id) || {name:entry.name, color:'sage'};
    return `<div class="chain-entry">${avatar(person)}<div><strong>${index + 1}. ${escapeHTML(entry.name)}</strong><p>${escapeHTML(entryText(entry))}</p></div></div>`;
  }).join('') : '<p class="chain-empty">No entries yet. Add the first one.</p>';
  $('#joinChainButton').textContent = chain.entries.some(entry => entry.actor_id === 'adrian') ? 'Update my entry' : 'Add my entry';
}
function openJoinChain(id) {
  const chain = state?.chains.find(item => item.id === id);
  if (!chain) return;
  closeDrawers(); joiningChain = id;
  $('#chainEntryInput').value = chain.entries.find(entry => entry.actor_id === 'adrian')?.text || '';
  formError('joinChainError'); renderChainEntries();
  $('#joinChainDialog').showModal();
}
function showReactions(id) {
  const message = state?.messages.find(item => item.id === id);
  if (!message) return;
  reactionMessage = id;
  $('#reactionOptions').innerHTML = reactionChoices.map((choice,index) => `<button class="reaction-choice" data-pick-reaction="${index}"><span>${escapeHTML(choice.emoji)}</span>${choice.label}${message.reactions?.[choice.emoji]?.includes('adrian') ? '<small>Reacted</small>' : ''}</button>`).join('');
  $('#reactionDialog').showModal();
}

document.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button || button.disabled) return;
  if (button.hasAttribute('data-close')) button.closest('dialog').close();
  if (button.dataset.person) showPerson(button.dataset.person);
  if (button.dataset.personTab) selectPersonTab(button.dataset.personTab);
  if (button.dataset.mentionIndex !== undefined) insertMention(Number(button.dataset.mentionIndex));
  if (button.dataset.joinChain) openJoinChain(button.dataset.joinChain);
  if (button.dataset.votePoll) {
    const id = button.dataset.votePoll;
    const index = Number(button.dataset.option);
    const poll = state?.polls.find(item => item.id === id);
    if (poll && poll.options[index] !== undefined) action(`polls/${id}/vote`, {option_index:index}).then(result => { if (result) toast('Your vote was saved.'); });
  }
  if (button.dataset.react) showReactions(Number(button.dataset.react));
  if (button.dataset.reactionEmoji) action('reactions', {message_id:Number(button.dataset.reactionMessage), emoji:button.dataset.reactionEmoji});
  if (button.dataset.pickReaction !== undefined) {
    const choice = reactionChoices[Number(button.dataset.pickReaction)];
    if (choice && reactionMessage) action('reactions', {message_id:reactionMessage,emoji:choice.emoji}).then(result => { if (result) $('#reactionDialog').close(); });
  }
  if (button.dataset.viewPerson) {
    personFilter = button.dataset.viewPerson;
    filter = 'all'; query = ''; $('#searchInput').value = '';
    $('#personDialog').close(); renderMessages(true);
  }
  if (button.hasAttribute('data-retry')) refresh(true);
  if (button.hasAttribute('data-clear-filters')) clearFilters();
  if (button.dataset.jump) {
    const id = Number(button.dataset.jump);
    if (!state?.messages.some(message => message.id === id)) return;
    closeDrawers(); if ($('#personDialog').open) $('#personDialog').close(); clearFilters();
    const node = document.getElementById(`message-${id}`);
    node?.scrollIntoView({block:'center', behavior:'instant'});
    node?.focus({preventScroll:true});
    node?.classList.add('highlight');
    setTimeout(() => node?.classList.remove('highlight'), 1800);
    updateUnread();
  }
  if (button.dataset.reply) {
    const message = state?.messages.find(item => item.id === Number(button.dataset.reply));
    if (!message) return;
    replyTo = message.id;
    $('#replyComposerText').textContent = `Reply ${message.name} · #${message.id}`;
    $('#replyComposer').hidden = false;
    $('#messageInput').focus();
  }
});
$$('dialog').forEach(dialog => dialog.addEventListener('click', event => {
  if (event.target !== dialog) return;
  const rect = dialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
}));
$('#connectionDialog').addEventListener('close', () => { $('#apiKeyInput').value = ''; });
$('#paceSelect').addEventListener('change', async () => {
  const nextPace = $('#paceSelect').value;
  if (await action('pace', {pace:nextPace})) pace = nextPace;
  else $('#paceSelect').value = pace;
});
$$('[data-filter]').forEach(button => button.addEventListener('click', () => { filter = button.dataset.filter; renderMessages(true); }));
$('#clearFilters').addEventListener('click', clearFilters);
$('#searchToggle').addEventListener('click', () => {
  const open = $('#searchRow').hidden;
  $('#searchRow').hidden = !open;
  $('#searchToggle').setAttribute('aria-expanded', String(open));
  if (open) $('#searchInput').focus();
  else { query = ''; $('#searchInput').value = ''; renderMessages(true); }
});
$('#clearSearch').addEventListener('click', () => { $('#searchRow').hidden = true; $('#searchToggle').setAttribute('aria-expanded','false'); query = ''; $('#searchInput').value = ''; renderMessages(true); $('#searchToggle').focus(); });
$('#searchInput').addEventListener('input', event => { query = event.target.value.trim(); renderMessages(true); });
$('#searchInput').addEventListener('keydown', event => { if (event.key === 'Escape') $('#clearSearch').click(); });
$('#contextToggle').addEventListener('click', () => {
  const expanded = $('#contextToggle').getAttribute('aria-expanded') !== 'true';
  $('#contextToggle').setAttribute('aria-expanded', String(expanded));
  $('#contextToggle').textContent = expanded ? 'Collapse' : 'Expand';
  $('#topicContext').classList.toggle('clamped', !expanded);
});
$('#showPeople').addEventListener('click', () => openDrawer('peopleDrawer','peoplePanel','peopleMount'));
$('#showControls').addEventListener('click', () => openDrawer('controlsDrawer','controlPanel','controlsMount'));
window.addEventListener('resize', () => { closeDrawers(); updateContextToggle(); updateUnread(); });
viewport.addEventListener('scroll', updateUnread, {passive:true});
$('#newMessagesButton').addEventListener('click', scrollToLatest);
$('#retryButton').addEventListener('click', () => refresh(true));
$('#cancelReply').addEventListener('click', clearReply);
$('#editPeopleButton').addEventListener('click', openSetup);
$('#editTopicButton').addEventListener('click', openPublicSettings);
$('#publicInfoButton').addEventListener('click', openPublicSettings);
$('#viewPersonMessages').addEventListener('click', () => {
  personFilter = selectedAgentId; filter = 'all'; query = ''; $('#searchInput').value = '';
  $('#personDialog').close(); renderMessages(true);
});
$('.inspector-tabs').addEventListener('keydown', event => {
  const tabs = $$('[data-person-tab]');
  const current = tabs.indexOf(event.target);
  if (current < 0 || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  selectPersonTab(tabs[next].dataset.personTab); tabs[next].focus();
});
function trackDraftInput(event, draft, fields, statusId) {
  const name = Object.keys(fields).find(key => fields[key] === event.target.id);
  if (!draft || !name) return;
  draft.values[name] = event.target.value;
  if (draft.values[name] === draft.baseline[name]) draft.dirty.delete(name); else draft.dirty.add(name);
  $(`#${statusId}`).textContent = draft.dirty.size ? `${countLabel(draft.dirty.size,'unsaved change')}` : 'Settings are up to date.';
  updateControls();
}
$('#agentForm').addEventListener('input', event => trackDraftInput(event,agentDrafts.get(selectedAgentId),agentFields,'agentSaveStatus'));
$('#publicForm').addEventListener('input', event => trackDraftInput(event,publicDraft,publicFields,'publicSaveStatus'));
$('#agentForm').addEventListener('submit', async event => {
  event.preventDefault();
  const id = selectedAgentId, draft = agentDrafts.get(id);
  if (!id || !draft?.dirty.size || busy.has(`agents/${id}`)) return;
  const changes = Object.fromEntries([...draft.dirty].map(name => [name,draft.values[name].trim()]));
  if (('name' in changes && !changes.name) || ('role' in changes && !changes.role) || ('background' in changes && changes.background.length < 5)) { formError('agentError','Enter a name, role, and a background of at least 5 characters.'); return; }
  const result = await action(`agents/${id}`,changes,'agentError','PATCH');
  if (!result) return;
  agentDrafts.delete(id);
  if (selectedAgentId === id) { syncAgentDraft(result,true); renderAgentObservation(result); await loadAgentDetail(true); }
  toast('Changes saved. The agent will load them on its next action.');
});
$('#publicForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!publicDraft?.dirty.size || busy.has('context')) return;
  const changes = Object.fromEntries([...publicDraft.dirty].map(name => [name,publicDraft.values[name].trim()]));
  if (('topic' in changes && changes.topic.length < 2) || ('context' in changes && changes.context.length < 5)) { formError('publicError','Enter a topic of at least 2 characters and shared context of at least 5 characters.'); return; }
  if (await action('context',changes,'publicError','PATCH')) { publicDraft = null; syncPublicDraft(true); toast('Shared settings saved. Agents will load them on their next actions.'); }
});
$('#connectionButton').addEventListener('click', openConnection);
$('#startButton').addEventListener('click', async () => {
  if (!state || state.running) return;
  if (!state.connection.ready) { openConnection(); return; }
  const result = await action('start', {pace:$('#paceSelect').value});
  if (result) toast('Conversation started. Join in at any time.');
});
$('#pauseButton').addEventListener('click', () => action('stop'));
$('#resetButton').addEventListener('click', () => {
  if (!state || state.running) return;
  closeDrawers(); formError('resetError');
  const marketScenario = state.scenario === 'market';
  $('#resetHeading').textContent = marketScenario ? 'Reset market' : 'Start a new conversation';
  $('#confirmResetButton').textContent = marketScenario ? 'Reset market' : 'Clear and start over';
  $('#resetDescription').textContent = marketScenario ? `Keep the current ${state.personas.length} traders. Cash and holdings return to their initial values. The ${state.messages.length} messages, orders, trades, group activities, and agent memories will be cleared.` : `Keep the current topic and ${state.personas.length} members. The ${state.messages.length} messages, polls, sign-up lists, and conversation memories will be cleared.`;
  $('#resetDialog').showModal();
});
$('#confirmResetButton').addEventListener('click', async () => {
  if (await action('reset', {}, 'resetError')) { $('#resetDialog').close(); clearReply(); toast('The new room is ready.'); }
});
function updateComposer() {
  const input = $('#messageInput');
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 115)}px`;
  $('#charCount').hidden = input.value.length < 900;
  $('#charCount').textContent = `${input.value.length} / 1200`;
  updateControls();
}
$('#messageInput').addEventListener('input', () => { updateComposer(); updateMentions(); });
$('#messageInput').addEventListener('keydown', event => {
  if (!$('#mentionPicker').hidden && !event.isComposing) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); mentionIndex = (mentionIndex + (event.key === 'ArrowDown' ? 1 : -1) + mentionOptions.length) % mentionOptions.length; renderMentionPicker(); return; }
    if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) { event.preventDefault(); insertMention(mentionIndex); return; }
    if (event.key === 'Escape') { event.preventDefault(); hideMentions(); return; }
  }
  if (!event.isComposing && (event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); if (!$('#sendButton').disabled) $('#messageForm').requestSubmit(); }
});
$('#messageForm').addEventListener('submit', async event => {
  event.preventDefault();
  const originalValue = $('#messageInput').value;
  const body = originalValue.trim();
  const sentReply = replyTo;
  if (!body || !online || busy.has('message')) return;
  hideMentions();
  if (await action('message', {body, reply_to:sentReply}, 'composerError')) {
    if ($('#messageInput').value === originalValue) $('#messageInput').value = '';
    if (replyTo === sentReply) clearReply();
    clearFilters(); scrollToLatest(); updateComposer();
    $('#messageInput').focus({preventScroll:true});
    toast('Message sent.');
  }
});
$('#addPersonButton').addEventListener('click', () => {
  collectDraft();
  if (personaDraft.length >= 8) return;
  personaDraft.push({id:`resident_${crypto.randomUUID().slice(0,8)}`,name:'',role:'',background:'',color:colors[personaDraft.length % colors.length]});
  renderEditors();
  $$('[data-editor]').at(-1).querySelector('[name="name"]').focus();
});
$('#personaEditors').addEventListener('click', event => {
  const button = event.target.closest('[data-remove-person]');
  if (!button || button.disabled || personaDraft.length <= 2) return;
  collectDraft(); personaDraft.splice(Number(button.dataset.removePerson),1); renderEditors();
});
$('#setupForm').addEventListener('submit', async event => {
  event.preventDefault(); collectDraft();
  const topic = $('#setupTopic').value.trim(), context = $('#setupContext').value.trim();
  if (topic.length < 2 || context.length < 5 || personaDraft.some(person => !person.name || !person.role || person.background.length < 5)) { formError('setupError','Complete the topic, shared context, and each member’s name, role, and background.'); return; }
  if (await action('setup', {topic, context, personas:personaDraft}, 'setupError')) { $('#setupDialog').close(); clearReply(); toast('Members and topic saved. The new conversation is ready.'); }
});
$('#connectionForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (await action('connection', {api_key:$('#apiKeyInput').value.trim()}, 'connectionError')) { $('#apiKeyInput').value = ''; $('#connectionDialog').close(); toast('Model connection saved.'); }
});

$('#mentionButton').addEventListener('click', () => {
  const input = $('#messageInput');
  const cursor = input.selectionStart;
  const prefix = cursor && !/\s$/.test(input.value.slice(0,cursor)) ? ' @' : '@';
  input.setRangeText(prefix, cursor, input.selectionEnd, 'end');
  input.focus(); updateComposer(); updateMentions();
});
document.addEventListener('pointerdown', event => { if (!event.target.closest('#mentionPicker, #mentionButton, #messageInput')) hideMentions(); });
$('#newPollButton').addEventListener('click', openPoll);
$('#newChainButton').addEventListener('click', openChain);
$('#addPollOption').addEventListener('click', () => {
  pollOptions = $$('#pollOptions input').map(input => input.value);
  if (pollOptions.length >= 6) return;
  pollOptions.push(''); renderPollOptions(); $$('#pollOptions input').at(-1).focus();
});
$('#pollOptions').addEventListener('click', event => {
  const button = event.target.closest('[data-remove-option]');
  if (!button || button.disabled) return;
  pollOptions = $$('#pollOptions input').map(input => input.value);
  pollOptions.splice(Number(button.dataset.removeOption),1); renderPollOptions();
});
$('#pollForm').addEventListener('submit', async event => {
  event.preventDefault();
  const question = $('#pollQuestion').value.trim();
  const options = $$('#pollOptions input').map(input => input.value.trim());
  if (!question || options.some(option => !option)) { formError('pollError','Enter a question and every option.'); return; }
  if (new Set(options).size !== options.length) { formError('pollError','Each option must be different.'); return; }
  if (await action('polls', {question,options}, 'pollError')) { $('#pollDialog').close(); clearFilters(); scrollToLatest(); toast('Poll created.'); }
});
$('#chainForm').addEventListener('submit', async event => {
  event.preventDefault();
  const title = $('#chainTitle').value.trim(), prompt = $('#chainDescription').value.trim() || 'Add your entry';
  if (!title) { formError('chainError','Enter a title.'); return; }
  if (await action('chains', {title,prompt}, 'chainError')) { $('#chainDialog').close(); clearFilters(); scrollToLatest(); toast('Sign-up list shared with the group.'); }
});
$('#joinChainForm').addEventListener('submit', async event => {
  event.preventDefault();
  const text = $('#chainEntryInput').value.trim();
  if (!text || !joiningChain) return;
  if (await action(`chains/${joiningChain}/join`, {text}, 'joinChainError')) { $('#joinChainDialog').close(); toast('Your entry was saved.'); }
});

async function poll() {
  clearTimeout(pollTimer);
  await refresh();
  clearTimeout(pollTimer);
  pollTimer = setTimeout(poll, document.hidden ? 5000 : 1000);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) { clearTimeout(pollTimer); poll(); } });
poll();
