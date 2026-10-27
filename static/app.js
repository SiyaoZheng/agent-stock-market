'use strict';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[char]));
const safeSourceURL = value => {
  if (typeof value !== 'string') return null;
  try { return ['https:','http:'].includes(new URL(value).protocol) ? value : null; }
  catch { return null; }
};
const colors = ['sage', 'blue', 'amber', 'rose', 'violet'];
const avatar = person => `<span class="avatar ${colors.includes(person.color) ? person.color : 'sage'}" aria-hidden="true">${escapeHTML([...person.name][0] || '?')}</span>`;
const time = value => new Date(value).toLocaleTimeString('zh-CN', {timeZone:'Asia/Shanghai', hour:'2-digit', minute:'2-digit', hour12:false});
const dateTime = value => new Date(value).toLocaleString('zh-CN', {timeZone:'Asia/Shanghai', month:'long', day:'numeric', hour:'2-digit', minute:'2-digit', hour12:false});
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
const preciseTime = value => value ? new Date(value).toLocaleTimeString('zh-CN', {timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}) : '';
const reactionChoices = [
  {label:'赞同', emoji:String.fromCodePoint(0x1f44d)}, {label:'不同意', emoji:String.fromCodePoint(0x1f44e)},
  {label:'好笑', emoji:String.fromCodePoint(0x1f602)}, {label:'生气', emoji:String.fromCodePoint(0x1f621)},
  {label:'喜欢', emoji:String.fromCodePoint(0x2764,0xfe0f)}, {label:'再想想', emoji:String.fromCodePoint(0x1f914)},
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
    catch { throw new Error('服务暂时没有返回有效数据，请稍后重试。'); }
    if (!response.ok) {
      throw new Error(typeof result.detail === 'string' ? result.detail : '请检查输入是否完整，以及文字是否超出长度限制。');
    }
    return result;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('连接等待超时，请稍后重试。');
    if (error instanceof TypeError) throw new Error('暂时无法连接本地服务，请确认 Demo 仍在运行。');
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
        $('#topicTitle').textContent = '群聊正在等待连接';
        $('#topicContext').textContent = '启动本地 Demo 后，成员、议题和已有留言会自动出现在这里。';
        $('#messages').innerHTML = '<div class="empty-board"><span class="empty-mark" aria-hidden="true">↳</span><h3>暂时无法连接群聊</h3><p>请确认本地 Demo 仍在运行。<br>页面会自动重新连接。</p><button class="secondary-button" data-retry>重新连接</button></div>';
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
    $('#liveText').textContent = '等待重新连接';
    $('#liveDot').className = 'status-dot offline';
    $('#runBadge').textContent = '未连接';
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
  $('#startText').textContent = busy.has('start') ? '正在启动…' : running ? '群聊进行中' : state?.messages.length ? '继续群聊' : '开始群聊';
  $('#pauseButton').hidden = !running;
  $('#pauseButton').disabled = !online || busy.has('stop') || !!state?.stopping;
  $('#pauseButton').textContent = state?.stopping || busy.has('stop') ? '暂停中…' : '暂停';
  $('#paceSelect').disabled = !state || !online || busy.has('pace');
  $('#messageInput').disabled = !state || !online;
  $('#sendButton').disabled = !state || !online || busy.has('message') || !$('#messageInput').value.trim();
  $('#sendButton').innerHTML = busy.has('message') ? '发送中…' : '发送 <span aria-hidden="true">↑</span>';
  $('#saveSetupButton').disabled = locked;
  $('#saveSetupButton').textContent = busy.has('setup') ? '正在保存…' : state?.scenario === 'market' ? '保存并重置市场' : '保存并新建';
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
  $('#saveAgentButton').textContent = savingAgent ? '正在保存…' : '保存修改';
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
    return `<button class="person-card ${active ? 'is-active' : ''}" data-person="${escapeHTML(person.id)}" aria-haspopup="dialog" aria-label="查看 ${escapeHTML(person.name)} 的背景">${avatar(person)}<span class="person-copy"><span class="person-name">${escapeHTML(person.name)}<span class="person-state">${active ? '正在输入' : '↗'}</span></span><span class="person-role">${escapeHTML(person.role)}</span><span class="person-snippet">${escapeHTML(person.background)}</span></span></button>`;
  }).join('');
  if (focusedPerson) $$('[data-person]').find(button => button.dataset.person === focusedPerson)?.focus({preventScroll:true});
  $('#peopleCount').textContent = state.personas.length;
  $('#mobilePeopleCount').textContent = state.personas.length;
  $('#groupCount').textContent = `· ${state.personas.length + 1} 人`;
}

function richText(body) {
  const names = [...(state?.personas || []), {id:'adrian',name:'Adrian'}, {id:'everyone',name:'所有人'}].sort((a,b) => b.name.length - a.name.length);
  const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`@(${names.map(person => escapeRegExp(person.name)).join('|')})`, 'g');
  let result = '', offset = 0;
  for (const match of String(body || '').matchAll(pattern)) {
    result += escapeHTML(body.slice(offset, match.index));
    const person = names.find(item => item.name === match[1]);
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
  return `<div class="interaction-card"><span class="type-label">群投票 · ${escapeHTML(personName(poll.creator_id))} 发起</span><h3>${escapeHTML(poll.question)}</h3><div class="poll-options">${poll.options.map((option,index) => {
    const count = poll.counts[index] || 0;
    const share = total ? Math.round(count / total * 100) : 0;
    const voters = Object.entries(poll.votes).filter(([,choice]) => choice === index).map(([id]) => personName(id)).join('、');
    return `<button class="poll-option ${selected === index ? 'selected' : ''}" data-vote-poll="${escapeHTML(poll.id)}" data-option="${index}" aria-pressed="${selected === index}" aria-label="投给${escapeHTML(option)}，${count}票${selected === index ? '，已选择' : ''}" title="${escapeHTML(voters || '还没有人选择')}" style="--vote-share:${share}%"><span class="option-fill" aria-hidden="true"></span><span class="option-marker" aria-hidden="true">${selected === index ? '✓' : ''}</span><span class="option-text">${escapeHTML(option)}</span><span class="option-count">${count} 票</span></button>`;
  }).join('')}</div><div class="card-meta"><span>${total} 人已投票</span><span>${selected !== undefined ? '已投票 · 点击可改选' : '点击选项投票'}</span></div></div>`;
}

function chainCard(chain) {
  const joined = chain.entries.some(entry => entry.actor_id === 'adrian');
  return `<div class="interaction-card"><span class="type-label">群接龙 · ${escapeHTML(personName(chain.creator_id))} 发起</span><h3>${escapeHTML(chain.title)}</h3>${chain.prompt ? `<p class="card-description">${escapeHTML(chain.prompt)}</p>` : ''}<div class="chain-preview">${chain.entries.slice(0,3).map((entry,index) => `<div class="chain-preview-item"><span>${index+1}.</span><p><strong>${escapeHTML(entry.name)}</strong>${escapeHTML(entryText(entry))}</p></div>`).join('')}</div>${!chain.entries.length ? '<p class="chain-empty">等你来接上第一条。</p>' : ''}<button class="card-action" data-join-chain="${escapeHTML(chain.id)}">${joined ? '查看 / 更新我的接龙' : '我来接龙'}${chain.entries.length > 3 ? ` · 查看全部 ${chain.entries.length} 条` : ''}</button><div class="card-meta"><span>${chain.entries.length} 人已接龙</span><span>${joined ? '你已参与' : '欢迎参与'}</span></div></div>`;
}

function reactionsMarkup(message) {
  return Object.entries(message.reactions || {}).filter(([,people]) => people.length).map(([emoji,people]) => `<button class="reaction-pill ${people.includes('adrian') ? 'selected' : ''}" data-reaction-message="${message.id}" data-reaction-emoji="${escapeHTML(emoji)}" aria-pressed="${people.includes('adrian')}" title="${escapeHTML(people.map(personName).join('、'))}" aria-label="${escapeHTML(emoji)}，${people.length}人回应${people.includes('adrian') ? '，点击取消我的回应' : ''}">${escapeHTML(emoji)} <span>${people.length}</span></button>`).join('');
}

function sourceCard(message) {
  const source = message.source;
  if (!source || typeof source !== 'object') return '';
  const url = safeSourceURL(source.url), title = source.title || '分享的搜索结果';
  const author = typeof source.author === 'object' && source.author ? source.author.name || source.author.nickname || source.author.username || '' : source.author || '';
  const published = source.published_at ? new Date(typeof source.published_at === 'number' && source.published_at < 1e12 ? source.published_at * 1000 : source.published_at) : null;
  const publishedLabel = published && !Number.isNaN(published.getTime()) ? published.toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}) : '';
  return `<div class="interaction-card message-source"><span class="type-label">${escapeHTML(source.platform_name || source.platform || '社交媒体')} · 分享来源</span><h3>${url ? `<a href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(title)}</a>` : escapeHTML(title)}</h3>${source.text ? `<p class="source-snippet">${escapeHTML(source.text)}</p>` : ''}${author || publishedLabel ? `<div class="source-byline">${author ? `<span>${escapeHTML(author)}</span>` : ''}${publishedLabel ? `<time>${publishedLabel}</time>` : ''}</div>` : ''}<div class="source-actions">${url ? `<a href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">查看原帖 ↗</a>` : ''}${source.search_id ? `<button type="button" data-shared-search="${escapeHTML(source.search_id)}" data-search-actor="${escapeHTML(message.author_id)}">查看这次检索</button>` : ''}</div></div>`;
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
  $('#newMessagesButton').innerHTML = `${unread ? `${unread} 条新留言` : '回到最新'} <span aria-hidden="true">↓</span>`;
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
      const author = isResident ? `<button class="author-button" data-person="${escapeHTML(message.author_id)}" aria-label="查看 ${escapeHTML(message.name)} 的背景">${escapeHTML(message.name)}</button>` : `<strong class="author-button">${escapeHTML(message.name)}</strong>`;
      const quote = parent ? `<button class="reply-quote" data-jump="${parent.id}" aria-label="查看 ${escapeHTML(parent.name)} 的原帖，第 ${parent.id} 条"><strong>回复 ${escapeHTML(parent.name)} · #${parent.id}<span aria-hidden="true">↗</span></strong><span>${escapeHTML(parent.body)}</span></button>` : '';
      const content = poll ? pollCard(poll) : chain ? chainCard(chain) : `${message.body ? `<p class="message-body">${richText(message.body)}</p>` : ''}${sourceCard(message)}`;
      node.innerHTML = `<div class="message-header">${avatar(message)}<div class="message-author">${author}<small>${escapeHTML(message.role)}</small></div><div class="message-stamp"><time datetime="${escapeHTML(message.time)}">${time(message.time)}</time></div></div>${quote}${content}<div class="message-reactions">${reactionsMarkup(message)}</div><div class="message-bottom"><button class="reply-button" data-reply="${message.id}" aria-label="回复 ${escapeHTML(message.name)} 的第 ${message.id} 条消息">↳ 回复</button><button class="reply-button" data-react="${message.id}" aria-label="回应第 ${message.id} 条消息">＋ 回应</button>${responseCount ? `<span class="reply-count">${responseCount} 条回复</span>` : ''}<span class="message-number">#${String(message.id).padStart(2,'0')}</span></div>`;
    }
    desired.push(node);
  }
  if (!desired.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-board';
    const narrowed = query || personFilter || filter !== 'all';
    const heading = filter === 'mentions' && !query ? '有人 @你时，会出现在这里' : filter === 'activities' && !query ? '群里的事，一起商量' : narrowed ? '没有找到对应的消息' : '第一声招呼，从你开始';
    const detail = filter === 'activities' && !query ? '用下方的「投票」和「接龙」发起群互动。' : narrowed ? '也可以回到群聊，看看大家正在说什么。' : '开始群聊，看看交易员如何判断行情。<br>或者先发条消息，和大家打个招呼。';
    empty.innerHTML = `<span class="empty-mark" aria-hidden="true">↳</span><h3>${heading}</h3><p>${detail}</p>${narrowed ? '<button class="secondary-button" data-clear-filters>回到群聊</button>' : ''}`;
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
    $('#screenReaderStatus').textContent = `${added} 条新消息，当前共 ${state.messages.length} 条。`;
    if (!follow) unread += added;
  }
  knownCount = state.messages.length;
  initialMessages = false;
  if (resetPosition) { viewport.scrollTop = 0; unread = 0; }
  else if (follow) scrollToLatest();
  updateUnread();
  const selectedPerson = state.personas.find(person => person.id === personFilter);
  $('#filterSummary').hidden = !personFilter && !query;
  $('#filterSummaryText').textContent = `${selectedPerson ? `${selectedPerson.name}的发言 · ` : ''}${query ? `搜索「${query}」 · ` : ''}${matching.length} 条消息`;
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
  $('#editPeopleButton').textContent = marketScenario ? '＋ 新建模拟市场' : '＋ 新建群聊';
  $('#resetButton').textContent = marketScenario ? '重置市场' : '新群聊';
  $('#setupHeading').textContent = marketScenario ? '设置新的模拟市场' : '设定话题与成员';
  $('#setupConsequence').textContent = marketScenario ? '保存后重置模拟市场的账户、委托、成交与聊天记录。' : '保存后开启新讨论。';
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
  $('#boardSummary').textContent = `${state.personas.length + 1} 位群成员 · ${state.messages.length} 条消息`;
  const typing = activeIds().map(personName);
  $('#liveText').textContent = state.stopping ? '正在暂停群聊…' : state.running && typing.length ? `${typing.slice(0,2).join('、')}${typing.length > 2 ? `等 ${typing.length} 人` : ''}正在输入…` : state.error ? '群聊已暂停，可以重试' : state.running ? '群聊进行中，随时加入' : state.messages.length ? '成员已暂停，你仍然可以发消息' : '群聊已就绪，来打个招呼吧';
  $('#liveRound').textContent = state.running ? '自由发言' : '所有人可见';
  $('#liveDot').className = `status-dot${state.running ? ' running' : ''}`;
  $('#runBadge').textContent = state.running ? state.stopping ? '即将暂停' : '进行中' : state.messages.length || state.error ? '已暂停' : '待开始';
  $('#runBadge').classList.toggle('running', state.running);
  $('#runStatus').textContent = state.running ? `${state.personas.length} 位成员自由发言中` : '可以随时继续聊天';
  if (!busy.has('pace') && state.pace) { pace = state.pace; $('#paceSelect').value = pace; }
  $('#activityTag').textContent = state.running ? '进行中' : '最近动态';
  $('#modelName').textContent = state.connection.model === 'deepseek-flash' ? 'DeepSeek Flash' : state.connection.model;
  $('#thinkingLabel').textContent = state.connection.thinking === 'disabled' ? '思考已关闭' : '思考已开启';
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
  const interactions = [...state.polls.map(poll => ({kind:'poll', title:poll.question, message:poll.message_id, time:poll.created_at, detail:`${Object.keys(poll.votes).length} 人已投票`})), ...state.chains.map(chain => ({kind:'chain', title:chain.title, message:chain.message_id, time:chain.created_at, detail:`${chain.entries.length} 人已接龙`}))].sort((a,b) => new Date(b.time) - new Date(a.time));
  $('#activeInteractionCount').textContent = interactions.length;
  $('#interactionList').innerHTML = interactions.length ? interactions.slice(0,4).map(item => `<button class="interaction-item" data-jump="${item.message}"><span class="type-icon" aria-hidden="true">${item.kind === 'poll' ? '≡' : '↳'}</span><span><strong>${escapeHTML(item.title)}</strong><small>${item.kind === 'poll' ? '投票' : '接龙'} · ${item.detail}</small></span></button>`).join('') : '<p class="panel-intro">一起投个票，或者发起一条接龙。</p>';
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
  $('#agentHistory').innerHTML = '<p class="loading-copy">正在读取最近状态…</p>';
  $('#effectiveInstructions').textContent = '';
  $('#preparedInstructions').textContent = '';
  $('#instructionsLoadedAt').textContent = '正在读取加载记录…';
  $('#loadedPersona').textContent = '正在读取已加载的人设…';
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
  $('#agentSaveStatus').textContent = draft.dirty.size ? `有 ${draft.dirty.size} 项修改尚未保存` : '已与当前设定同步';
  updateControls();
}
function renderAgentObservation(detail) {
  const typing = activeIds().includes(selectedAgentId);
  $('#agentStatus').textContent = typing ? '正在准备群消息' : state?.running ? '群聊持续运行中' : '当前已暂停';
  $('#agentStatusDot').className = `status-dot${typing ? ' running' : ''}`;
  $('#agentUpdated').textContent = preciseTime(detail.updated_at);
  $('#thoughtSummary').textContent = detail.thought_summary || '等待这个角色生成第一条想法摘要。';
  $('#agentIntention').textContent = detail.intention || '等待下一次行动';
  $('#agentMood').textContent = detail.mood || '尚未表达';
  const pending = typeof detail.loaded_epoch !== 'number' || detail.loaded_epoch !== detail.epoch;
  const text = pending ? `新设定已保存 · 等待角色加载（版本 ${detail.epoch ?? 0}）` : `当前设定已加载 · 版本 ${detail.epoch}${detail.loaded_at ? ` · ${preciseTime(detail.loaded_at)}` : ''}`;
  for (const id of ['agentLoadedState','agentFormLoadedState']) { $(`#${id}`).textContent = text; $(`#${id}`).classList.toggle('pending',pending); }
  const readIds = detail.last_read_message_ids || [];
  $('#agentReadSummary').textContent = `最近读到 ${readIds.length} 条群消息${detail.last_read_at ? ` · ${preciseTime(detail.last_read_at)}` : ''}`;
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
    $('#effectiveInstructions').textContent = detail.loaded_instructions || '等待角色第一次加载设定。';
    $('#preparedInstructions').textContent = detail.effective_instructions || '';
    $('#instructionsLoadedAt').textContent = detail.loaded_at ? `最近实际加载 · ${preciseTime(detail.loaded_at)} · 版本 ${detail.loaded_epoch}` : '尚未加载';
    const loaded = detail.loaded_persona;
    $('#loadedPersona').textContent = loaded ? `${loaded.name} · ${loaded.role}\n${loaded.background}` : '等待角色第一次加载人设。';
    $('#agentHistory').innerHTML = detail.history?.length ? [...detail.history].reverse().map(entry => `<article class="agent-history-item"><div class="history-meta"><time>${preciseTime(entry.time)}</time><span>${escapeHTML(entry.mood || '')}</span></div><p>${escapeHTML(entry.summary || '')}</p><small>${escapeHTML(entry.intention || entry.action || '')}</small></article>`).join('') : '<p class="loading-copy">角色的想法与行动会记录在这里。</p>';
  } catch (error) { if (selectedAgentId === id) formError('agentError',error.message); }
  finally { agentDetailBusy = false; }
}
function syncPublicDraft(replace = false) {
  if (!state) return;
  const values = {topic:state.topic, context:state.context, shared_rules:state.shared_rules || ''};
  if (!publicDraft) publicDraft = makeDraft(values);
  syncDraftFields(publicDraft,values,publicFields,replace);
  $('#publicSaveStatus').textContent = publicDraft.dirty.size ? `有 ${publicDraft.dirty.size} 项修改尚未保存` : '已与当前公共设定同步';
  const loaded = state.personas.filter(person => { const detail = state.agent_states?.[person.id]; return detail && typeof detail.loaded_epoch === 'number' && detail.loaded_epoch === detail.epoch; });
  $('#publicLoadedState').textContent = loaded.length === state.personas.length ? `全部 ${loaded.length} 位成员已加载当前设定` : `${loaded.length} / ${state.personas.length} 位成员已加载当前设定，其余正在更新`;
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
  $('#personaEditors').innerHTML = personaDraft.map((person,index) => `<section class="persona-editor" data-editor="${index}"><div class="editor-heading">${avatar(person)}<strong>成员 ${index + 1}</strong><button type="button" class="quiet-button" data-remove-person="${index}" ${personaDraft.length <= 2 ? 'disabled' : ''} aria-label="移除 ${escapeHTML(person.name || `成员${index+1}`)}">移除</button></div><div class="editor-row"><label>姓名<input name="name" value="${escapeHTML(person.name)}" maxlength="30" required></label><label>身份<input name="role" value="${escapeHTML(person.role)}" maxlength="60" required></label></div><label>生活背景<textarea name="background" rows="3" minlength="5" maxlength="1500" required>${escapeHTML(person.background)}</textarea></label></section>`).join('');
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
  $('#connectionStatus').textContent = state.connection.ready ? '已有凭证可用' : '等待填写 API Key';
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
  const match = input.value.slice(0,cursor).match(/(?:^|[\s，。！？,.!?])@([^\s@，。！？,.!?]{0,30})$/u);
  if (!match) { hideMentions(); return; }
  const people = [...state.personas, {id:'everyone',name:'所有人',role:'全部群成员',color:'sage'}];
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
  $('#pollOptions').innerHTML = pollOptions.map((option,index) => `<div class="option-editor"><input aria-label="投票选项 ${index+1}" value="${escapeHTML(option)}" placeholder="选项 ${index+1}" required maxlength="80"><button class="icon-button" type="button" data-remove-option="${index}" aria-label="移除投票选项 ${index+1}" ${pollOptions.length <= 2 ? 'disabled' : ''}>×</button></div>`).join('');
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
  }).join('') : '<p class="chain-empty">还没有人接龙，来写下第一条吧。</p>';
  $('#joinChainButton').textContent = chain.entries.some(entry => entry.actor_id === 'adrian') ? '更新我的接龙' : '接上我的';
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
  $('#reactionOptions').innerHTML = reactionChoices.map((choice,index) => `<button class="reaction-choice" data-pick-reaction="${index}"><span>${escapeHTML(choice.emoji)}</span>${choice.label}${message.reactions?.[choice.emoji]?.includes('adrian') ? '<small>已回应</small>' : ''}</button>`).join('');
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
    if (poll && poll.options[index] !== undefined) action(`polls/${id}/vote`, {option_index:index}).then(result => { if (result) toast('你的选择已记下。'); });
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
    $('#replyComposerText').textContent = `回复 ${message.name} · #${message.id}`;
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
  $('#contextToggle').textContent = expanded ? '收起' : '展开';
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
  $(`#${statusId}`).textContent = draft.dirty.size ? `有 ${draft.dirty.size} 项修改尚未保存` : '已与当前设定同步';
  updateControls();
}
$('#agentForm').addEventListener('input', event => trackDraftInput(event,agentDrafts.get(selectedAgentId),agentFields,'agentSaveStatus'));
$('#publicForm').addEventListener('input', event => trackDraftInput(event,publicDraft,publicFields,'publicSaveStatus'));
$('#agentForm').addEventListener('submit', async event => {
  event.preventDefault();
  const id = selectedAgentId, draft = agentDrafts.get(id);
  if (!id || !draft?.dirty.size || busy.has(`agents/${id}`)) return;
  const changes = Object.fromEntries([...draft.dirty].map(name => [name,draft.values[name].trim()]));
  if (('name' in changes && !changes.name) || ('role' in changes && !changes.role) || ('background' in changes && changes.background.length < 5)) { formError('agentError','请填写姓名、身份和至少 5 个字的人设背景。'); return; }
  const result = await action(`agents/${id}`,changes,'agentError','PATCH');
  if (!result) return;
  agentDrafts.delete(id);
  if (selectedAgentId === id) { syncAgentDraft(result,true); renderAgentObservation(result); await loadAgentDetail(true); }
  toast('修改已保存，角色正在加载新设定。');
});
$('#publicForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!publicDraft?.dirty.size || busy.has('context')) return;
  const changes = Object.fromEntries([...publicDraft.dirty].map(name => [name,publicDraft.values[name].trim()]));
  if (('topic' in changes && changes.topic.length < 2) || ('context' in changes && changes.context.length < 5)) { formError('publicError','请填写至少 2 个字的议题和至少 5 个字的公共信息。'); return; }
  if (await action('context',changes,'publicError','PATCH')) { publicDraft = null; syncPublicDraft(true); toast('公共设定已保存，成员正在逐一加载。'); }
});
$('#connectionButton').addEventListener('click', openConnection);
$('#startButton').addEventListener('click', async () => {
  if (!state || state.running) return;
  if (!state.connection.ready) { openConnection(); return; }
  const result = await action('start', {pace:$('#paceSelect').value});
  if (result) toast('群聊已开始，随时可以插句话。');
});
$('#pauseButton').addEventListener('click', () => action('stop'));
$('#resetButton').addEventListener('click', () => {
  if (!state || state.running) return;
  closeDrawers(); formError('resetError');
  const marketScenario = state.scenario === 'market';
  $('#resetHeading').textContent = marketScenario ? '重置模拟市场' : '开启一场新讨论';
  $('#confirmResetButton').textContent = marketScenario ? '确认重置市场' : '清空并开始新讨论';
  $('#resetDescription').textContent = marketScenario ? `继续使用当前的 ${state.personas.length} 位交易员。现金和持仓恢复初始值，当前 ${state.messages.length} 条消息、委托、成交、群互动和角色记忆将被清空。` : `继续使用当前话题和 ${state.personas.length} 位成员。当前的 ${state.messages.length} 条消息、投票、接龙及成员对话记忆将被清空。`;
  $('#resetDialog').showModal();
});
$('#confirmResetButton').addEventListener('click', async () => {
  if (await action('reset', {}, 'resetError')) { $('#resetDialog').close(); clearReply(); toast('新的留言板已就绪。'); }
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
    toast('消息已发送到群里。');
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
  if (topic.length < 2 || context.length < 5 || personaDraft.some(person => !person.name || !person.role || person.background.length < 5)) { formError('setupError','请填写完整的议题、公共信息，以及每位成员的姓名、身份和生活背景。'); return; }
  if (await action('setup', {topic, context, personas:personaDraft}, 'setupError')) { $('#setupDialog').close(); clearReply(); toast('人物与议题已更新，新的讨论已就绪。'); }
});
$('#connectionForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (await action('connection', {api_key:$('#apiKeyInput').value.trim()}, 'connectionError')) { $('#apiKeyInput').value = ''; $('#connectionDialog').close(); toast('模型连接设置已保存。'); }
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
  if (!question || options.some(option => !option)) { formError('pollError','请填写问题和每个选项。'); return; }
  if (new Set(options).size !== options.length) { formError('pollError','请为每个选项填写不同的内容。'); return; }
  if (await action('polls', {question,options}, 'pollError')) { $('#pollDialog').close(); clearFilters(); scrollToLatest(); toast('群投票已发起。'); }
});
$('#chainForm').addEventListener('submit', async event => {
  event.preventDefault();
  const title = $('#chainTitle').value.trim(), prompt = $('#chainDescription').value.trim() || '填写你想接龙的内容';
  if (!title) { formError('chainError','请填写接龙标题。'); return; }
  if (await action('chains', {title,prompt}, 'chainError')) { $('#chainDialog').close(); clearFilters(); scrollToLatest(); toast('接龙已发到群里。'); }
});
$('#joinChainForm').addEventListener('submit', async event => {
  event.preventDefault();
  const text = $('#chainEntryInput').value.trim();
  if (!text || !joiningChain) return;
  if (await action(`chains/${joiningChain}/join`, {text}, 'joinChainError')) { $('#joinChainDialog').close(); toast('你的接龙内容已保存。'); }
});

async function poll() {
  clearTimeout(pollTimer);
  await refresh();
  clearTimeout(pollTimer);
  pollTimer = setTimeout(poll, document.hidden ? 5000 : 1000);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) { clearTimeout(pollTimer); poll(); } });
poll();
