'use strict';

(() => {
  const focus = window.observerState;
  let snapshot = null, connected = false;
  let eventLimit = 80, events = [];
  let loading = false, nextLoadAt = 0, lastOrderKey = '', detailError = false, sessionKey = '';
  const details = new Map(), detailKeys = new Map(), orders = new Map(), markup = new Map();
  const actor = () => focus.actor();
  const num = (value, digits = 2) => Number.isFinite(Number(value)) ? Number(value).toLocaleString('en-US', {minimumFractionDigits:digits,maximumFractionDigits:digits}) : '—';
  const signed = (value, digits = 2) => `${value > 0 ? '+' : ''}${num(value,digits)}`;
  const tone = value => value > 0 ? 'profit' : value < 0 ? 'loss' : 'unchanged';
  const titleCase = value => String(value || '').replaceAll('_',' ').replace(/^./,letter=>letter.toUpperCase());
  const name = id => snapshot?.personas.find(person=>person.id===id)?.name || (id==='adrian' ? 'Adrian' : id==='opening_liquidity' ? 'Opening liquidity' : personName(id));
  const renderHTML = (id,html) => { if(markup.get(id)!==html) {markup.set(id,html); $(id).innerHTML=html;} };
  const relatedOrders=new Map(), relatedTrades=new Map(), relatedMessages=new Map();
  const unique = records => [...new Map(records.map(record=>[record.id,record])).values()];
  const allOrders = () => unique([...relatedOrders.values(),...[...orders.values()].flat(),...(snapshot?.market?.my_orders || [])]);
  const allMessages = () => unique([...relatedMessages.values(),...(snapshot?.messages || [])]);
  const eventFor = key => events.find(event=>event.key===key);
  const involved = event => !actor() || event.actors.includes(actor());
  const linkEvent = (key,label,extra='') => `<button type="button" class="record-link" data-trajectory-key="${escapeHTML(key)}" ${extra}>${escapeHTML(label)} <span aria-hidden="true">↗</span></button>`;
  const messageLink = (message,label) => `<button type="button" class="record-link" data-jump="${Number(message.id)}">${escapeHTML(label || `Message #${message.id}`)} <span aria-hidden="true">↗</span></button>`;

  function trades() {
    const detailed = new Map([...relatedTrades.values(),...(snapshot?.market?.trades || [])].map(trade=>[trade.id,trade]));
    return unique([...detailed.values(),...(snapshot?.market?.stocks || []).flatMap(stock=>(stock.history || []).map(point=>({id:point.trade_id,symbol:stock.symbol,quantity:point.volume,...point,...(detailed.get(point.trade_id) || {})})))]);
  }
  function buildEvents() {
    if(!snapshot) return [];
    const list = [];
    const add = event => {if(event.time && Number.isFinite(Date.parse(event.time))) list.push({...event,ts:Date.parse(event.time)});};
    const orderList = allOrders(), knownOrders = new Set(orderList.map(order=>order.id));
    for(const trade of trades()) add({key:`trade:${trade.id}`,kind:'trade',group:'market',time:trade.time,actors:[trade.buyer_id,trade.seller_id],actor:trade.aggressor_id || trade.buyer_id,symbol:trade.symbol,trade,title:`${name(trade.buyer_id)} bought ${num(trade.quantity,0)} ${trade.symbol}`,text:`from ${name(trade.seller_id)} at ${num(trade.price)}`,impact:trade.price_change});
    for(const order of orderList) {
      add({key:`order:${order.id}`,kind:'order',group:'market',time:order.created_at,actors:[order.actor_id],actor:order.actor_id,symbol:order.symbol,order,title:`${name(order.actor_id)} placed a ${order.side} order`,text:`${order.symbol} · ${num(order.quantity,0)} shares · ${order.order_type==='market' ? 'Market' : `Limit ${num(order.limit_price)}`}`});
      if(order.status==='cancelled') add({key:`cancel:${order.id}`,kind:'cancel',group:'market',time:order.updated_at,actors:[order.actor_id],actor:order.actor_id,symbol:order.symbol,order,title:`${name(order.actor_id)} cancelled ${order.symbol}`,text:`${num(order.remaining,0)} unfilled shares · ${order.id}`});
    }
    for(const message of allMessages()) {
      if(message.type==='order' && knownOrders.has(message.order_id)) continue;
      const kind = message.source ? 'source' : message.type==='order' ? 'order' : 'message';
      add({key:message.type==='order' ? `order:${message.order_id}` : `message:${message.id}`,kind,group:kind==='source' ? 'research' : kind==='order' ? 'market' : 'message',time:message.time,actors:[message.author_id],actor:message.author_id,message,title:`${name(message.author_id)} ${kind==='source' ? 'shared a source' : kind==='order' ? 'updated an order' : 'posted a message'}`,text:message.body || message.source?.title || ''});
    }
    for(const search of window.socialSearchUI?.records() || snapshot.social_search?.records || []) add({key:`search:${search.id}`,kind:'search',group:'research',time:search.started_at,actors:[search.actor_id],actor:search.actor_id,search,title:`${name(search.actor_id)} searched ${socialPlatformName(search.platform,search.platform_name)}`,text:search.query});
    for(const [id,detail] of details) {
      for(const entry of detail.history || []) add({key:`decision:${id}:${entry.time}`,kind:'decision',group:'decision',time:entry.time,actors:[id],actor:id,decision:entry,title:`${name(id)} updated their view`,text:entry.summary || entry.intention || ''});
      if(detail.last_read_at) add({key:`read:${id}:${detail.last_read_at}`,kind:'read',group:'decision',time:detail.last_read_at,actors:[id],actor:id,read:detail,title:`${name(id)} read the room`,text:`${countLabel(detail.last_read_message_ids?.length || 0,'message')} · latest recorded observation`});
    }
    for(const event of window.activityUI?.events() || []) add(event);
    return list.sort((a,b)=>b.ts-a.ts || b.time.localeCompare(a.time) || a.key.localeCompare(b.key));
  }

  function show(next) {
    if(!['overview','research','discussion'].includes(next)) return;
    const changed=focus.workspace!==next; focus.setWorkspace(next);
    document.body.dataset.terminalView=focus.workspace;
    $('#overviewView').hidden=focus.workspace!=='overview'; $('#researchView').hidden=focus.workspace!=='research'; $('#discussionView').hidden=focus.workspace!=='discussion';
    $$('[data-terminal-view]').forEach(button=>{const chosen=button.dataset.terminalView===focus.workspace;button.classList.toggle('selected',chosen);button.setAttribute('aria-pressed',String(chosen));});
    if(changed) $('.workspace').scrollTop=0;
    if(focus.workspace==='overview') window.marketAnalytics?.render(true);
    if(focus.workspace==='research') window.socialSearchUI?.render();
    if(focus.workspace==='discussion' && changed) scrollToLatest();
  }
  function showData(next) {
    focus.setDataPanel(next);
    $$('[data-terminal-data]').forEach(button=>{const chosen=button.dataset.terminalData===next;button.classList.toggle('selected',chosen);button.setAttribute('aria-pressed',String(chosen));});
    $$('[data-terminal-panel]').forEach(panel=>{panel.hidden=panel.dataset.terminalPanel!==next;});
  }
  function setPerspective(next, id=focus.traderId) {
    if(!focus.selectPerspective(next,id)) return;
    $('#perspectiveTrader').value=focus.traderId || ''; $('#perspectiveTrader').disabled=focus.perspective!=='trader';
    $$('[data-perspective]').forEach(button=>{const chosen=button.dataset.perspective===focus.perspective;button.classList.toggle('selected',chosen);button.setAttribute('aria-pressed',String(chosen));});
    window.marketAnalytics?.setActor(); window.socialSearchUI?.setActor(); window.activityUI?.ensureScope(actor());
    render(); window.marketUI?.select(focus.symbol,false); window.marketAnalytics?.render(true);
    scrollSelection(); $('.workspace').scrollTop=0;
  }
  function renderSummary() {
    const id=actor(), account=snapshot.market?.accounts.find(account=>account.actor_id===id), person=snapshot.personas.find(person=>person.id===id);
    $('#perspectiveCaption').textContent=id ? `${name(id)}’s information, actions, and account` : 'All traders · Shared market';
    $('#portfolioTabLabel').textContent=id ? 'Portfolio' : 'All accounts';
    $('[data-terminal-data="orders"]').textContent=id ? `${name(id)}’s orders` : 'Adrian’s orders';
    if(id && person && account) {
      renderHTML('#perspectiveSummary',`<div class="perspective-identity">${avatar(person)}<div><span class="eyebrow">TRADER TERMINAL</span><h2>${escapeHTML(person.name)}</h2><p>${escapeHTML(person.role)}</p></div><button type="button" class="quiet-button" data-person="${escapeHTML(id)}">Persona & memory ↗</button></div><div class="perspective-metrics"><div><span>Equity</span><strong>${num(account.equity)}</strong></div><div><span>Total P/L</span><strong class="${tone(account.pnl)}">${signed(account.pnl)}<small>${signed(account.pnl/account.initial_equity*100,4)}%</small></strong></div><div><span>Available cash</span><strong>${num(account.available_cash)}</strong></div></div>`);
      renderHTML('#personalHoldings',`<div class="personal-holdings-grid">${snapshot.market.stocks.map(stock=>`<div class="holding-card"><div class="holding-title"><b>${escapeHTML(stock.symbol)}</b><span>${escapeHTML(stock.name)}</span></div><strong>${num(account.positions?.[stock.symbol] || 0,0)} <small>shares</small></strong><dl><div><dt>Market value</dt><dd>${num(account.position_values?.[stock.symbol] ?? (account.positions?.[stock.symbol] || 0)*stock.last_price)}</dd></div><div><dt>Available to sell</dt><dd>${num(account.available_positions?.[stock.symbol] || 0,0)}</dd></div></dl></div>`).join('')}</div><div class="portfolio-cash"><span>Cash <b>${num(account.cash)}</b></span><span>Reserved for orders <b>${num(account.reserved_cash)}</b></span></div>`);
      const privateState=snapshot.agent_states?.[id] || {};
      renderHTML('#personalContext',`<div class="personal-view-state"><div><h3>Current view</h3><p>${escapeHTML(privateState.thought_summary || 'Waiting for a recorded view.')}</p></div><div><h3>Next intention</h3><p>${escapeHTML(privateState.intention || 'Waiting for a recorded intention.')}</p></div></div>`);
      const ownOrders=allOrders().filter(order=>order.actor_id===id);
      renderHTML('#traderOrders',`<div class="data-panel-caption"><h3>${escapeHTML(name(id))}’s orders</h3><span>${ownOrders.length} recorded</span></div>${ownOrders.length ? `<div class="trader-order-table"><table><thead><tr><th>Order</th><th>Side</th><th>Symbol</th><th>Price</th><th>Filled / Qty</th><th>Status</th></tr></thead><tbody>${ownOrders.map(order=>`<tr><td>${linkEvent(`order:${order.id}`,order.id)}</td><td class="${order.side==='buy' ? 'profit' : 'loss'}">${titleCase(order.side)}</td><td>${escapeHTML(order.symbol)}</td><td>${order.order_type==='market' ? 'Market' : num(order.limit_price)}</td><td>${num(order.filled_quantity,0)} / ${num(order.quantity,0)}</td><td>${titleCase(order.status)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="market-empty">No orders recorded.</p>'}`);
    } else {
      const volume=trades().reduce((sum,trade)=>sum+Number(trade.quantity),0);
      renderHTML('#perspectiveSummary',`<div class="perspective-identity"><span class="observer-symbol" aria-hidden="true">◎</span><div><span class="eyebrow">OBSERVER VIEW</span><h2>Market & agent activity</h2><p>Follow the connections between information, orders, and executions.</p></div></div><div class="observer-metrics"><span><b>${num(trades().length,0)}</b> trades</span><span><b>${num(volume,0)}</b> shares</span><span><b>${snapshot.social_search?.records.length || 0}</b> searches</span></div>`);
    }
    $('#perspectiveSummary').hidden=!id;
    $('.account-table-scroll').hidden=!!id;
    $('.account-sort-label').hidden=!!id;
    $('.table-scroll-hint').hidden=!!id;
    $('#personalHoldings').hidden=!id;
    $('#personalContext').hidden=!id;
    $('#traderOrders').hidden=!id;
    $$('.market-activity > :not(#traderOrders)').forEach(element=>{
      if(element.id==='tradesList') element.hidden=!!id || !$('[data-market-view="trades"]').classList.contains('selected');
      else if(element.id==='ordersList') element.hidden=!!id || !$('[data-market-view="orders"]').classList.contains('selected');
      else element.hidden=!!id;
    });
  }
  function renderTimeline() {
    $('#trajectoryFilter').value=focus.trajectoryFilter;
    const visible=events.filter(event=>involved(event) && (focus.trajectoryFilter==='all' || event.group===focus.trajectoryFilter));
    $('#trajectoryCount').textContent=visible.length;
    $('#trajectoryScope').textContent=actor() ? `${name(actor())} · Private observations and public market actions` : 'All traders · Agent runs and recorded market actions';
    const labels={activity:'AGENT RUN',trade:'EXECUTION',order:'ORDER',cancel:'CANCEL',message:'MESSAGE',source:'SOURCE',search:'SEARCH',decision:'VIEW UPDATE',read:'OBSERVATION'};
    renderHTML('#trajectoryList',`${detailError ? '<p class="activity-load-error">Some activity could not be refreshed. Retrying…</p>' : ''}${focus.eventOffset>0 ? '<button type="button" class="load-activity" id="newerActivity">Show newer activity ↑</button>' : ''}${visible.length ? visible.slice(focus.eventOffset,focus.eventOffset+eventLimit).map(event=>`<button type="button" class="trajectory-event ${event.key===focus.eventKey ? 'selected' : ''}" data-trajectory-key="${escapeHTML(event.key)}" aria-pressed="${event.key===focus.eventKey}"><span class="trajectory-event-top"><span class="event-kind ${event.kind}">${labels[event.kind]}</span><time>${preciseTime(event.time)}</time>${event.activity ? window.activityUI.statusMarkup(event.activity) : ''}${event.kind==='trade' ? `<span class="event-impact ${tone(event.impact)}">Δ ${signed(event.impact)}</span>` : ''}</span><strong>${escapeHTML(event.title)}</strong><span class="event-excerpt">${escapeHTML(event.text)}</span></button>`).join('') : `<div class="search-empty"><strong>${focus.trajectoryFilter==='activity' ? 'No recorded runs yet' : 'No matching activity'}</strong><p>${focus.trajectoryFilter==='activity' ? 'Each future agent run will appear here with its steps and outcome.' : 'Activity will appear here as this trader observes, searches, and acts.'}</p></div>`}${visible.length>focus.eventOffset+eventLimit ? `<button type="button" class="load-activity" id="loadMoreActivity">Show more activity · ${visible.length-focus.eventOffset-eventLimit} remaining</button>` : ''}${['all','activity'].includes(focus.trajectoryFilter) ? window.activityUI?.footer(actor()) || '' : ''}`);
  }
  function marketAt(event) {
    const prices=(snapshot.market?.stocks || []).map(stock=>{
      const earlier=(stock.history || []).filter(point=>Date.parse(point.time)<=event.ts).at(-1);
      return `<span>${escapeHTML(stock.symbol)} <b>${num(earlier?.price ?? stock.initial_price)}</b></span>`;
    }).join('');
    return `<div class="event-market-snapshot"><span>Last traded prices at this time</span><div>${prices}</div></div>`;
  }
  function readLinks(ids, observedMessages=allMessages()) {
    const messages=(ids || []).map(id=>observedMessages.find(message=>message.id===id)).filter(Boolean);
    return messages.length ? `<details class="observed-messages"><summary>${countLabel(messages.length,'message')} read</summary>${messages.map(message=>`<div>${messageLink(message,`#${message.id} · ${name(message.author_id)}`)}<p>${escapeHTML(message.body || message.source?.title || '')}</p></div>`).join('')}</details>` : '';
  }
  function renderDetail() {
    const event=eventFor(focus.eventKey);
    if(!event) {renderHTML('#trajectoryDetail','<div class="detail-placeholder">Select a chart point or activity to inspect its connections.</div>'); return;}
    let content='';
    if(event.activity) {
      content=window.activityUI.detail(event.activity,{readLinks,messageLink,linkEvent,hasEvent:key=>!!eventFor(key)})+marketAt(event);
    } else if(event.trade) {
      const trade=event.trade, before=Number(trade.price)-Number(trade.price_change || 0);
      const participantLink=id=>snapshot.personas.some(person=>person.id===id) ? `<button type="button" data-open-trader="${escapeHTML(id)}">${escapeHTML(name(id))} ↗</button>` : escapeHTML(name(id));
      const orderLink=(id,who)=>id && eventFor(`order:${id}`) && (!actor() || who===actor()) ? linkEvent(`order:${id}`,`${name(who)} · ${id}`) : escapeHTML(`${name(who)}${id ? ` · ${id}` : ''}`);
      content=`<div class="relationship-heading"><span>Matched orders → execution</span><b>${escapeHTML(trade.id)}</b></div><div class="matched-orders"><div><span class="profit">BUY ORDER</span>${orderLink(trade.buy_order_id,trade.buyer_id)}</div><div><span class="loss">SELL ORDER</span>${orderLink(trade.sell_order_id,trade.seller_id)}</div></div><div class="execution-impact"><div><span>Previous price</span><strong>${num(before)}</strong></div><span class="impact-arrow" aria-hidden="true">→</span><div><span>${escapeHTML(trade.symbol)} execution</span><strong>${num(trade.price)}</strong></div><div><span>Price change</span><strong class="${tone(trade.price_change)}">${signed(trade.price_change)}</strong></div></div><p class="detail-meta">${num(trade.quantity,0)} shares · Initiated by ${escapeHTML(name(trade.aggressor_id || trade.buyer_id))} (${trade.aggressor_side || 'buy'})</p><div class="position-transfer"><span>${participantLink(trade.buyer_id)} <b class="profit">+${num(trade.quantity,0)} ${escapeHTML(trade.symbol)}</b></span><span>${participantLink(trade.seller_id)} <b class="loss">−${num(trade.quantity,0)} ${escapeHTML(trade.symbol)}</b></span></div>`;
    } else if(event.order) {
      const order=event.order, fills=trades().filter(trade=>trade.buy_order_id===order.id || trade.sell_order_id===order.id);
      const linkedMessages=allMessages().filter(message=>message.order_id===order.id);
      const prior=events.filter(item=>item.kind==='decision' && item.actor===order.actor_id && item.ts<=Date.parse(order.created_at)).sort((a,b)=>b.ts-a.ts)[0];
      content=`<div class="relationship-heading"><span>${titleCase(order.side)} ${escapeHTML(order.symbol)}</span><b>${escapeHTML(order.id)}</b></div><div class="order-facts"><div><span>Order price</span><b>${order.order_type==='market' ? 'Market' : num(order.limit_price)}</b></div><div><span>Filled / quantity</span><b>${num(order.filled_quantity,0)} / ${num(order.quantity,0)}</b></div><div><span>Current status</span><b>${titleCase(order.status)}</b></div></div><div class="linked-records"><h4>Executions</h4>${fills.length ? fills.map(trade=>linkEvent(`trade:${trade.id}`,`${trade.id} · ${num(trade.quantity,0)} @ ${num(trade.price)}`)).join('') : '<p>No recorded execution for this order.</p>'}${linkedMessages.map(message=>messageLink(message)).join('')}${prior ? `<h4>Earlier view update · ${num((Date.parse(order.created_at)-prior.ts)/1000,0)}s before order</h4>${linkEvent(prior.key,`${name(prior.actor)} · ${preciseTime(prior.time)}`)}` : ''}</div>${marketAt(event)}`;
    } else if(event.search) {
      const search=event.search, shares=allMessages().filter(message=>message.source?.search_id===search.id);
      content=`<div class="relationship-heading"><span>${escapeHTML(socialPlatformName(search.platform,search.platform_name))} search</span><b>${escapeHTML(search.id)}</b></div><p class="event-full-text">${escapeHTML(search.query)}</p><p class="detail-meta">${titleCase(search.status)} · ${countLabel(search.result_count ?? search.results?.length ?? 0,'result')}${search.finished_at ? ` · Finished ${preciseTime(search.finished_at)}` : ''}</p><button type="button" class="detail-primary" data-open-trajectory-search="${escapeHTML(search.id)}" data-actor="${escapeHTML(search.actor_id)}">Read search results ↗</button>${shares.length ? `<div class="linked-records"><h4>Shared in the trading room</h4>${shares.map(message=>linkEvent(`message:${message.id}`,`Message #${message.id} · ${name(message.author_id)}`)).join('')}</div>` : ''}${marketAt(event)}`;
    } else if(event.decision) {
      const entry=event.decision, next=events.filter(item=>item.order && item.kind==='order' && item.actor===event.actor && item.ts>=event.ts).sort((a,b)=>a.ts-b.ts)[0];
      content=`<div class="relationship-heading"><span>${escapeHTML(name(event.actor))}’s recorded view</span></div><p class="event-full-text">${escapeHTML(entry.summary || '')}</p>${entry.intention ? `<h4>Intention</h4><p class="event-full-text">${escapeHTML(entry.intention)}</p>` : ''}<p class="detail-meta">${escapeHTML(entry.action || '')}${entry.mood ? ` · ${escapeHTML(entry.mood)}` : ''}</p>${readLinks(entry.observed_message_ids)}${next ? `<div class="linked-records"><h4>Next order in time · ${num((next.ts-event.ts)/1000,0)}s later</h4>${linkEvent(next.key,`${next.order.id} · ${next.symbol}`)}</div>` : ''}${marketAt(event)}`;
    } else if(event.read) {
      content=`<div class="relationship-heading"><span>${escapeHTML(name(event.actor))}’s latest observation</span></div>${readLinks(event.read.last_read_message_ids)}${marketAt(event)}`;
    } else if(event.message) {
      const message=event.message, searchKey=message.source?.search_id ? `search:${message.source.search_id}` : null;
      content=`<div class="relationship-heading"><span>${escapeHTML(name(event.actor))}</span><b>Message #${message.id}</b></div><p class="event-full-text">${escapeHTML(message.body || '')}</p>${message.source ? `<h4>${escapeHTML(message.source.title || 'Shared source')}</h4>${searchKey && eventFor(searchKey) ? linkEvent(searchKey,`Original search ${message.source.search_id}`) : ''}` : ''}${message.reply_to ? `<p>${messageLink({id:message.reply_to},`Reply to message #${message.reply_to}`)}</p>` : ''}<p>${messageLink(message,'Open in discussion')}</p>${marketAt(event)}`;
    }
    if(!event.activity) content+=window.activityUI?.related(event) || '';
    if(!involved(event)) content=`<p class="inspecting-outside-scope">Inspecting ${escapeHTML(name(event.actor))}’s record · ${escapeHTML(name(actor()))}’s terminal remains selected</p>`+content;
    renderHTML('#trajectoryDetail',`<div class="selected-activity-heading"><span>SELECTED ACTIVITY</span><time>${preciseTime(event.time)}</time></div>${content}`);
  }
  function scrollSelection() {
    const selected=$('.trajectory-event.selected');
    if(selected) $('#trajectoryList').scrollTop=Math.max(0,selected.offsetTop-50);
  }
  function focusEvent(key, scroll=true) {
    if(!focus.selectEvent(key)) return;
    renderTimeline();renderDetail();
    window.marketUI?.select(focus.symbol,false); window.marketAnalytics?.render(true);
    if(scroll) scrollSelection();
  }
  function focusTrade(id,fromChart=false) {
    if(!fromChart && !focus.selectTrade(id)) return;
    renderTimeline();renderDetail();scrollSelection();
    if(!fromChart) window.marketAnalytics?.render(true);
  }
  function render() {
    if(!snapshot?.market) return;
    events=buildEvents(); focus.registerEvents(events); renderSummary();
    if(focus.chartMarker) window.marketAnalytics?.render();
    renderTimeline();renderDetail();
  }
  async function loadDetails() {
    if(loading || !connected || Date.now()<nextLoadAt || !snapshot) return;
    const requestedSession=sessionKey;
    const people=snapshot.personas;
    const orderKey=JSON.stringify([(allMessages()).filter(message=>message.type==='order').map(message=>message.id),snapshot.market?.trades?.[0]?.id]);
    const jobs=[];
    for(const person of people) {
      const current=snapshot.agent_states?.[person.id] || {};
      const key=JSON.stringify([current.updated_at,current.last_read_at,current.loaded_at,current.epoch]);
      if(detailKeys.get(person.id)!==key) jobs.push({type:'detail',id:person.id,key,path:`agents/${encodeURIComponent(person.id)}`});
      if(lastOrderKey!==orderKey) jobs.push({type:'orders',id:person.id,path:`market/orders?actor_id=${encodeURIComponent(person.id)}`});
    }
    if(!jobs.length) return;
    loading=true; nextLoadAt=Date.now()+3000;
    const results=await Promise.allSettled(jobs.map(job=>api(job.path)));
    if(requestedSession!==sessionKey) {loading=false;return;}
    detailError=results.some(result=>result.status==='rejected');
    results.forEach((result,index)=>{if(result.status!=='fulfilled') return;const job=jobs[index];if(job.type==='detail'){details.set(job.id,result.value);detailKeys.set(job.id,job.key);}else orders.set(job.id,result.value);});
    if(!results.some((result,index)=>jobs[index].type==='orders' && result.status==='rejected')) lastOrderKey=orderKey;
    loading=false;render();
  }
  function update(nextState,isConnected) {
    connected=isConnected;if(nextState) snapshot=nextState;
    if(!snapshot?.market) return;
    const currentSession=String(snapshot.market.stocks?.[0]?.started_at || snapshot.created_at || '');
    if(sessionKey!==currentSession) {sessionKey=currentSession;details.clear();detailKeys.clear();orders.clear();relatedOrders.clear();relatedTrades.clear();relatedMessages.clear();lastOrderKey='';nextLoadAt=0;}
    const optionHTML=snapshot.personas.map(person=>`<option value="${escapeHTML(person.id)}">${escapeHTML(person.name)}</option>`).join('');
    renderHTML('#perspectiveTrader',optionHTML); $('#perspectiveTrader').value=focus.traderId;
    $('#configureModel').disabled=$('#connectionButton').disabled;
    $('#terminalRunState').textContent=!connected ? 'Reconnecting' : snapshot.running ? 'Agents running' : 'Agents paused';
    $('#terminalRunState').classList.toggle('running',connected && snapshot.running);
    $('#terminalTradeCount').textContent=num(trades().length,0);$('#terminalAgentCount').textContent=snapshot.personas.length;
    render(); void loadDetails();
  }
  document.addEventListener('click',event=>{
    const button=event.target.closest('button');if(!button || button.disabled) return;
    if(button.id==='viewTraderTerminal' && selectedAgentId) {$('#personDialog').close();setPerspective('trader',selectedAgentId);show('overview');}
    if(button.dataset.traceMessage) {const message=allMessages().find(message=>message.id===Number(button.dataset.traceMessage));if(message){show('overview');focusEvent(message.order_id ? `order:${message.order_id}` : `message:${message.id}`);}}
    if(button.dataset.openTrader) {const previous=focus.eventKey;setPerspective('trader',button.dataset.openTrader);if(previous) focusEvent(previous);$('.workspace').scrollTop=0;}
    if(button.dataset.terminalView) show(button.dataset.terminalView);
    if(button.dataset.terminalSection) {show('overview');const section={chart:'#analyticsPanel',activity:'.trajectory-column',portfolio:'#terminalData'}[button.dataset.terminalSection];if(button.dataset.terminalSection==='portfolio') showData('accounts');$(section)?.scrollIntoView({block:'start',behavior:'smooth'});}
    if(button.dataset.terminalData) showData(button.dataset.terminalData);
    if(button.dataset.perspective) setPerspective(button.dataset.perspective);
    if(button.dataset.trajectoryKey) {show('overview');focusEvent(button.dataset.trajectoryKey);}
    if(button.dataset.openTrajectorySearch) window.socialSearchUI?.open({actorId:button.dataset.actor,recordId:button.dataset.openTrajectorySearch});
    if(button.id==='loadMoreActivity') {focus.movePage(1);renderTimeline();$('#trajectoryList').scrollTop=0;}
    if(button.id==='newerActivity') {focus.movePage(-1);renderTimeline();$('#trajectoryList').scrollTop=0;}
  });
  $('#perspectiveTrader').addEventListener('change',event=>setPerspective('trader',event.target.value));
  function filterTrajectory(value) {
    focus.setTrajectoryFilter(value); renderTimeline();renderDetail();window.marketUI?.select(focus.symbol,false);window.marketAnalytics?.render(true);$('#trajectoryList').scrollTop=0;
  }
  $('#trajectoryFilter').addEventListener('change',event=>filterTrajectory(event.target.value));
  $('#followTrajectory').addEventListener('click',()=>{const latest=events.find(event=>involved(event) && (focus.trajectoryFilter==='all' || event.group===focus.trajectoryFilter));if(latest) focusEvent(latest.key);});
  $('#configureModel').addEventListener('click',()=>{closeDrawers();$('#connectionButton').click();});
  $('#openOrderTicket').addEventListener('click',()=>$('#orderDialog').showModal());
  function ingestRelated(related) {
    if(!related) return;
    (related.orders || []).forEach(order=>relatedOrders.set(order.id,order));
    (related.trades || []).forEach(trade=>relatedTrades.set(trade.id,trade));
    (related.messages || []).forEach(message=>relatedMessages.set(message.id,message));
    window.socialSearchUI?.ingest(related.searches || []);
  }
  async function openActivity(id) {
    show('overview');
    if(!eventFor(`activity:${id}`)) {
      const record=await window.activityUI?.load(id);render();
      if(!record) {toast(`Could not load run ${id}. Please try again.`);return;}
    }
    focusEvent(`activity:${id}`);
  }
  function showActivities(id) {
    if(id && actor()!==id) setPerspective('trader',id);
    show('overview'); filterTrajectory('activity');
  }
  window.terminalUI={update,show,showData,actor,focusTrade,openActivity,showActivities,ingestRelated,refresh:render,openEvent(key){show('overview');focusEvent(key);},openTrader(id){setPerspective('trader',id);show('overview');},onStockChange(){render();scrollSelection();}};
  update(state,online);
})();
