'use strict';

(() => {
  let snapshot = null, connected = false, session = null, supported = false;
  const summaries = new Map(), full = new Map(), requests = new Map(), failures = new Map(), pages = new Map();
  const esc = escapeHTML;
  const title = text => String(text || '').replaceAll('_',' ').replace(/^./,letter=>letter.toUpperCase());
  const who = record => snapshot?.personas.find(person=>person.id===record.actor_id)?.name || record.actor_name || personName(record.actor_id);
  const status = record => ['running','completed','interrupted','failed','rejected'].includes(record.status) ? record.status : 'running';
  const statusMarkup = record => `<span class="run-status ${status(record)}">${title(status(record))}${record.partial ? ' · Partial' : ''}</span>`;
  const scopeKey = actorId => actorId || 'all';
  const refresh = () => { window.terminalUI?.refresh(); renderInspector(); };
  const records = () => [...summaries.values()].sort((a,b)=>Number(b.sequence)-Number(a.sequence));
  function pageFor(actorId) {
    const key=scopeKey(actorId);
    if(!pages.has(key)) pages.set(key,{initialized:false,before:null,total:0,loading:false,error:'',revision:null,checked:0});
    return pages.get(key);
  }
  function ingest(page, actorId=null, older=false) {
    if(!page || !Array.isArray(page.records)) return;
    const overlaps=page.records.some(record=>summaries.has(String(record.id)));
    page.records.forEach(record=>{
      const {steps,reviews,observations,effects,related,...summary}=record;
      if(Array.isArray(steps)) summary.step_count=steps.length;
      summaries.set(String(record.id),summary);
    });
    const cursor=pageFor(actorId);
    if(!cursor.initialized || older || !overlaps) cursor.before=page.next_before ?? null;
    cursor.initialized=true; cursor.total=page.total ?? page.records.length; cursor.revision=page.revision;
  }
  async function loadPage(actorId=null, older=false) {
    if(!supported || !connected) return;
    const cursor=pageFor(actorId);
    if(cursor.loading || (older && (!cursor.initialized || cursor.before==null))) return;
    cursor.loading=true; cursor.error=''; cursor.checked=Date.now(); refresh();
    const requestedSession=session;
    const query=new URLSearchParams({limit:'50'});
    if(actorId) query.set('actor_id',actorId);
    if(older) query.set('before',String(cursor.before));
    try {
      const page=await api(`activities?${query}`);
      if(requestedSession===session) ingest(page,actorId,older);
    } catch(error) { if(requestedSession===session) cursor.error=error.message; }
    finally { cursor.loading=false; if(requestedSession===session) refresh(); }
  }
  function ensureScope(actorId) {
    if(!supported || !actorId) return;
    const cursor=pageFor(actorId);
    if((!cursor.initialized || cursor.revision!==snapshot?.activities?.revision) && Date.now()-cursor.checked>3000) void loadPage(actorId);
  }
  async function load(id, force=false) {
    id=String(id);
    if(requests.has(id)) return requests.get(id);
    const signature=JSON.stringify(summaries.get(id));
    const cached=full.get(id), failure=failures.get(id);
    const marketRevision=summaries.get(id)?.order_ids?.length ? JSON.stringify([snapshot?.market?.trades?.[0]?.id,snapshot?.messages?.filter(message=>message.type==='order').at(-1)?.id]) : '';
    if(!force && cached?.signature===signature && cached.marketRevision===marketRevision && (cached.record.status!=='running' || Date.now()-cached.loadedAt<1500)) return cached.record;
    if(!force && failure && Date.now()-failure.time<8000) return null;
    const requestedSession=session;
    const promise=(async()=>{
      try {
        const record=await api(`activities/${encodeURIComponent(id)}`);
        if(requestedSession!==session) return null;
        const {steps,reviews,observations,effects,related,...summary}=record;
        window.terminalUI?.ingestRelated(related);
        summary.step_count=steps?.length || 0;
        summaries.set(id,summary);
        full.set(id,{record,signature:JSON.stringify(summary),marketRevision,loadedAt:Date.now()}); failures.delete(id);
        return record;
      } catch(error) {
        if(requestedSession===session) failures.set(id,{message:error.message,time:Date.now()});
        return null;
      } finally { requests.delete(id); if(requestedSession===session) refresh(); }
    })();
    requests.set(id,promise);
    return promise;
  }
  function events() {
    return records().map(record=>({key:`activity:${record.id}`,kind:'activity',group:'activity',time:record.started_at,actors:[record.actor_id],actor:record.actor_id,activity:record,title:`${who(record)} · ${record.outcome || 'In progress'}`,text:record.summary || record.reason || `${record.step_count || 0} recorded steps`}));
  }
  const activityLink = (id,label) => `<button type="button" class="record-link" data-open-activity="${esc(id)}">${esc(label || id)} ↗</button>`;
  function related(event) {
    const direct=event.message?.activity_id || event.search?.activity_id || event.decision?.activity_id;
    const ids=new Set(direct ? [String(direct)] : []), orderContext=new Set();
    for(const record of summaries.values()) {
      if((event.trade && record.trade_ids?.includes(event.trade.id)) || (event.order && record.order_ids?.includes(event.order.id)) || (event.message && record.message_ids?.includes(event.message.id)) || (event.search && record.search_ids?.includes(event.search.id))) ids.add(String(record.id));
      else if(event.trade && (record.order_ids?.includes(event.trade.buy_order_id) || record.order_ids?.includes(event.trade.sell_order_id))) orderContext.add(String(record.id));
    }
    const links=set=>[...set].map(id=>activityLink(id,`${summaries.has(id) ? who(summaries.get(id))+' · ' : ''}${id}`)).join('');
    return `${ids.size ? `<div class="linked-records"><h4>${event.trade ? 'Run that recorded this execution' : 'Agent run'}</h4>${links(ids)}</div>` : ''}${orderContext.size ? `<div class="linked-records"><h4>Runs linked by a matched order</h4>${links(orderContext)}</div>` : ''}`;
  }
  function detail(record, helpers) {
    const id=String(record.id), cached=full.get(id), failure=failures.get(id);
    void load(id);
    const duration=record.finished_at ? Math.max(0,(Date.parse(record.finished_at)-Date.parse(record.started_at))/1000) : null;
    let content=`<div class="relationship-heading"><span>${esc(who(record))}’s run</span><b>${esc(id)}</b></div><div class="run-outcome">${statusMarkup(record)}<strong>${esc(record.outcome || 'In progress')}</strong></div><p class="detail-meta">Started ${preciseTime(record.started_at)}${record.finished_at ? ` · Finished ${preciseTime(record.finished_at)} · ${duration.toLocaleString('en-US',{maximumFractionDigits:1})}s` : ' · In progress'} · Settings v${Number(record.epoch || 0)}</p>${record.reason ? `<p class="run-reason">${esc(record.reason)}</p>` : ''}`;
    if(!cached) return content+(failure ? `<p class="activity-load-error">${esc(failure.message)}</p><button type="button" class="detail-primary" data-retry-activity="${esc(id)}">Retry loading this run</button>` : '<p class="detail-meta" role="status">Loading recorded steps…</p>');
    if(failure) content+=`<p class="activity-load-error">Could not refresh the recorded steps.</p><button type="button" class="detail-primary" data-retry-activity="${esc(id)}">Retry loading this run</button>`;
    const run=cached.record;
    const names={read_group:'Read group messages',update_private_state:'Update view and intention',get_market_snapshot:'Inspect market',get_account:'Inspect own account',search_social_media:'Search social media',place_order:'Place order',cancel_order:'Cancel order',share_search_result:'Share a search result',send_message:'Send message',send_messages:'Send messages',stay_silent:'Stay silent'};
    const effects=run.effects || [];
    function effectLink(effect) {
      const id=effect.id;
      if(effect.kind==='message') return helpers.messageLink({id},`Message #${id}`);
      if(effect.kind==='order' || effect.kind==='trade') return helpers.hasEvent(`${effect.kind}:${id}`) ? helpers.linkEvent(`${effect.kind}:${id}`,`${title(effect.kind)} ${id}`) : `<span>${esc(title(effect.kind))} ${esc(id)}</span>`;
      const item=effect.kind==='poll' || effect.kind==='vote' ? snapshot.polls?.find(poll=>String(poll.id)===String(id)) : effect.kind==='chain' ? snapshot.chains?.find(chain=>String(chain.id)===String(id)) : null;
      const messageId=effect.kind==='reaction' ? id : item?.message_id;
      return messageId ? helpers.messageLink({id:messageId},`${title(effect.kind)} #${id}`) : `<span>${esc(title(effect.kind))} #${esc(id)}${effect.operation ? ` · ${esc(effect.operation)}` : ''}</span>`;
    }
    const steps=(run.steps || []).map(step=>{
      const observed=(run.observations || []).filter(observation=>observation.step_id===step.id);
      const stepEffects=effects.filter(effect=>effect.step_id===step.id);
      const observations=observed.map(observation=>{
        if(observation.kind==='group') return helpers.readLinks(observation.message_ids,observation.data?.messages)+ (observation.data ? `<details class="run-observation"><summary>Observed group context</summary><pre>${esc(JSON.stringify(observation.data,null,2))}</pre></details>` : '');
        const data=observation.data || {};
        const account=data.account;
        const quote=Array.isArray(data.stocks) ? data.stocks.map(stock=>`${stock.symbol} ${Number(stock.last_price).toFixed(2)}`).join(' · ') : '';
        return `<details class="run-observation"><summary>${account ? `Observed account · Equity ${Number(account.equity).toLocaleString('en-US')}` : `Observed market${quote ? ' · '+esc(quote) : ''}`}</summary><pre>${esc(JSON.stringify(data,null,2))}</pre></details>`;
      }).join('');
      return `<li class="run-step"><div class="run-step-heading"><strong>${esc(names[step.name] || title(step.name))}</strong>${statusMarkup(step)}</div><p class="detail-meta">${preciseTime(step.started_at)}${step.finished_at ? ` → ${preciseTime(step.finished_at)}` : ''} · ${esc(title(step.kind))}</p>${step.error ? `<p class="run-reason">${esc(step.error)}</p>` : ''}${observations}${stepEffects.length ? `<div class="run-step-effects">${stepEffects.map(effectLink).join('')}</div>` : ''}</li>`;
    }).join('');
    content+=`<h4>Recorded steps · ${run.steps?.length || 0}</h4>${steps ? `<ol class="run-steps">${steps}</ol>` : '<p class="detail-meta">This run has no recorded tool steps.</p>'}`;
    if(run.reviews?.length) content+=`<details class="run-reviews"><summary>Reported views and intentions · ${run.reviews.length}</summary>${run.reviews.map(review=>`<article><time>${preciseTime(review.time)}</time><p class="event-full-text">${esc(review.summary || '')}</p>${review.intention ? `<h4>Intention</h4><p class="event-full-text">${esc(review.intention)}</p>` : ''}${review.mood ? `<p class="detail-meta">Mood · ${esc(review.mood)}</p>` : ''}${helpers.readLinks(review.observed_message_ids)}</article>`).join('')}</details>`;
    const linked=[...(run.order_ids || []).map(id=>({kind:'order',id})),...(run.trade_ids || []).map(id=>({kind:'trade',id})),...(run.message_ids || []).map(id=>({kind:'message',id}))];
    if(linked.length) content+=`<div class="linked-records"><h4>Outputs from this run</h4>${linked.map(effectLink).join('')}</div>`;
    const laterFills=(run.related?.trades || []).filter(trade=>!(run.trade_ids || []).includes(trade.id) && ((run.order_ids || []).includes(trade.buy_order_id) || (run.order_ids || []).includes(trade.sell_order_id)));
    if(laterFills.length) content+=`<div class="linked-records"><h4>Later fills of this run’s orders</h4>${laterFills.map(trade=>effectLink({kind:'trade',id:trade.id})).join('')}</div>`;
    if(run.search_ids?.length) content+=`<div class="linked-records"><h4>Searches from this run</h4>${run.search_ids.map(id=>helpers.hasEvent(`search:${id}`) ? helpers.linkEvent(`search:${id}`,id) : `<span class="record-id">${esc(id)}</span>`).join('')}</div>`;
    return content;
  }
  function footer(actorId) {
    if(!supported) return '';
    const cursor=pageFor(actorId);
    const loaded=records().filter(record=>!actorId || record.actor_id===actorId).length;
    if(cursor.error) return `<p class="activity-load-error">Could not load run history: ${esc(cursor.error)}</p><button type="button" class="load-activity" data-load-run-page="${cursor.initialized ? 'older' : 'first'}">Retry run history</button>`;
    if(cursor.loading) return '<p class="run-page-status" role="status">Loading run history…</p>';
    return cursor.before!=null && loaded<cursor.total ? `<button type="button" class="load-activity" data-load-run-page="older">Load older runs · ${loaded} of ${cursor.total}</button>` : '';
  }
  function renderInspector() {
    if(!$('#personDialog').open || !selectedAgentId || !$('#agentRunHistory')) return;
    const own=records().filter(record=>record.actor_id===selectedAgentId).slice(0,5);
    const html=own.length ? own.map(record=>`<div class="inspector-run">${activityLink(record.id,`${preciseTime(record.started_at)} · ${record.outcome || 'In progress'}`)}${statusMarkup(record)}</div>`).join('') : '<p class="loading-copy">No recorded runs yet.</p>';
    if($('#agentRunHistory').innerHTML!==html) $('#agentRunHistory').innerHTML=html;
  }
  function update(next, online) {
    connected=online; if(!next) return; snapshot=next;
    const key=window.observerState.session;
    if(session!==key) { session=key; summaries.clear(); full.clear(); failures.clear(); pages.clear(); }
    supported=!!next.activities;
    if(supported) ingest(next.activities);
    ensureScope(window.observerState.actor());
    renderInspector();
  }
  document.addEventListener('click',event=>{
    const button=event.target.closest('button'); if(!button || button.disabled) return;
    if(button.dataset.openActivity) {if($('#personDialog').open) $('#personDialog').close();window.terminalUI?.openActivity(button.dataset.openActivity);}
    if(button.dataset.retryActivity) void load(button.dataset.retryActivity,true);
    if(button.dataset.loadRunPage) void loadPage(window.observerState.actor(),button.dataset.loadRunPage==='older');
    if(button.id==='viewAgentActivities') {$('#personDialog').close();window.terminalUI?.showActivities(selectedAgentId);}
  });
  window.activityUI={update,ingest,events,detail,related,footer,load,ensureScope,renderInspector,statusMarkup,supported:()=>supported};
})();
