'use strict';

(() => {
  const focus = window.observerState, selection = focus.research;
  let data = null, connected = false, cacheSession = null;
  const recordCache = new Map();
  let filterKey = '', listKey = '', detailKey = '', agentKey = '', renderedAgentId = null;
  const records = () => [...recordCache.values()].sort((a,b)=>Date.parse(b.started_at)-Date.parse(a.started_at) || String(b.id).localeCompare(String(a.id)));
  const statusName = record => ({searching:'Searching',completed:'Complete',error:'Incomplete'}[record.status] || 'Waiting');
  const resultCount = record => record.result_count ?? record.results?.length ?? 0;
  const platformName = record => socialPlatformName(record.platform,record.platform_name);
  const actorName = record => state?.personas?.find(person=>person.id===record.actor_id)?.name || record.actor_name || personName(record.actor_id);
  const statusMarkup = record => `<span class="search-status ${['searching','completed','error'].includes(record.status) ? record.status : ''}">${statusName(record)}</span>`;
  const safeURL = safeSourceURL;
  function sourceDate(value) {
    if (!value) return '';
    const date = new Date(typeof value === 'number' ? value < 1e12 ? value*1000 : value : value);
    return Number.isNaN(date.getTime()) ? String(value).slice(0,50) : date.toLocaleString('en-US',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  }
  function metricsMarkup(metrics) {
    if (!metrics || typeof metrics !== 'object') return '';
    const names={likes:'Likes',like_count:'Likes',liked_count:'Likes',digg_count:'Likes',attitudes_count:'Likes',upvote_count:'Upvotes',comments:'Comments',comment_count:'Comments',comments_count:'Comments',shares:'Shares',share_count:'Shares',reposts_count:'Reposts',repost_count:'Reposts',retweet_count:'Reposts',views:'Views',view_count:'Views',read_count:'Reads',play_count:'Plays',favorites:'Saves',favorite_count:'Saves',collect_count:'Saves',collected_count:'Saves'};
    const seen=new Set();
    return Object.entries(metrics).filter(([key,value])=>names[key] && value!=null).map(([key,value])=> {
      if(seen.has(names[key])) return ''; seen.add(names[key]);
      const count=typeof value==='number' ? value.toLocaleString('en-US') : String(value).slice(0,30);
      return `<span>${escapeHTML(names[key])} ${escapeHTML(count)}</span>`;
    }).join('');
  }
  function resultMarkup(result,index) {
    const url=safeURL(result.url);
    const title=result.title || `Search result ${index+1}`;
    const author=typeof result.author==='object' && result.author ? result.author.name || result.author.nickname || result.author.username || '' : result.author || '';
    const text=String(result.text || '');
    const published=sourceDate(result.published_at);
    return `<article class="social-result"><div class="social-result-heading"><span class="result-index">${index+1}</span><h4>${url ? `<a href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(title)} <span aria-hidden="true">↗</span></a>` : escapeHTML(title)}</h4></div>${author || published ? `<div class="social-result-meta">${author ? `<span>${escapeHTML(author)}</span>` : ''}${published ? `<time>${escapeHTML(published)}</time>` : ''}</div>` : ''}${text ? `<p class="social-result-text">${escapeHTML(text)}</p>` : ''}${text.length>90 ? '<button type="button" class="expand-result" data-expand-result aria-expanded="false">Show more</button>' : ''}<div class="social-metrics">${metricsMarkup(result.metrics)}</div>${url ? `<a class="social-source-link" href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">Open source ↗</a>` : ''}</article>`;
  }
  function errorMarkup(error) {
    const message=String(error || '');
    const billing=message.match(/https?:\/\/socialdatax\.com\/dashboard\/billing(?:[?#][^\s<>"']*)?/i);
    const url=billing && safeURL(billing[0]);
    const detail=url ? message.replace(url,'').replace(/(?:add credits|top up credits|recharge)\s*:\s*$/i,'').trim() : message;
    return `${detail ? `<p>${escapeHTML(detail.slice(0,600))}</p>` : ''}${url ? `<a class="search-recharge" href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">Add credits ↗</a>` : ''}`;
  }
  function resultsMarkup(record) {
    const items=Array.isArray(record.results) ? record.results : [];
    if(record.status==='searching' && !items.length) return '<div class="search-waiting"><span class="search-spinner" aria-hidden="true"></span><p>Searching. Results will appear automatically.</p></div>';
    if(record.status==='error' && !items.length) return `<div class="search-failure"><strong>Search did not complete</strong>${errorMarkup(record.error)}</div>`;
    if(!items.length) return '<div class="search-empty">This search returned no results.</div>';
    return `${record.status==='error' ? '<p class="search-partial-note">Results received so far.</p>' : ''}${items.map(resultMarkup).join('')}`;
  }
  function filteredRecords() { return records().filter(record=>(selection.actor==='all' || String(record.actor_id)===selection.actor) && (selection.platform==='all' || String(record.platform)===selection.platform)); }
  function renderFilters() {
    const people=new Map((state?.personas || []).map(person=>[String(person.id),person.name]));
    records().forEach(record=>people.set(String(record.actor_id),actorName(record)));
    const platforms=new Map((data?.platforms || []).map(item=>[String(item.id),socialPlatformName(item.id,item.name)]));
    records().forEach(record=>platforms.set(String(record.platform),platformName(record)));
    const key=JSON.stringify([[...people],[...platforms]]);
    if(filterKey!==key){
      filterKey=key;
      $('#socialActorFilter').innerHTML='<option value="all">All traders</option>'+[...people].map(([id,name])=>`<option value="${escapeHTML(id)}">${escapeHTML(name)}</option>`).join('');
      $('#socialPlatformFilter').innerHTML='<option value="all">All platforms</option>'+[...platforms].map(([id,name])=>`<option value="${escapeHTML(id)}">${escapeHTML(name)}</option>`).join('');
    }
    $('#socialActorFilter').disabled=!!focus.actor();
    $('#socialActorFilter').value=selection.actor; $('#socialPlatformFilter').value=selection.platform;
  }
  function render() {
    if($('#researchView').hidden) return;
    renderFilters();
    const focused=window.terminalUI?.actor();
    $('#socialSearchHeading').textContent=focused ? `${personName(focused)}’s research` : 'Social media searches';
    $('.social-search-heading p').textContent=focused ? 'Private search history and sources for this trader.' : 'Explore each trader’s private searches and sources.';
    const provider=data?.provider || 'SocialDataX';
    $('#socialProviderStatus').textContent=!connected ? 'Reconnecting' : data?.available ? `${provider} · ${data.platforms?.length || 0} platforms` : `${provider} · ${data ? 'Disconnected' : 'Connecting'}`;
    $('#socialProviderStatus').classList.toggle('available',!!connected && !!data?.available);
    const visible=filteredRecords();
    $('#socialRecordCount').textContent=`${countLabel(visible.length,'search','searches')}`;
    $('#followLatestSearch').disabled=!visible.length;
    $('#followLatestSearch').classList.toggle('following',selection.following);
    $('#followLatestSearch').setAttribute('aria-pressed',String(selection.following));
    $('#followLatestSearch').textContent=selection.following ? 'Following latest' : 'Follow latest';
    const nextListKey=JSON.stringify([selection.selected,visible.map(record=>[record.id,record.actor_id,actorName(record),platformName(record),record.query,record.status,resultCount(record),record.started_at])]);
    if(nextListKey!==listKey){
      listKey=nextListKey;
      $('#socialSearchRecords').innerHTML=visible.length ? visible.map(record=>`<button type="button" class="search-record ${String(record.id)===selection.selected ? 'selected' : ''}" data-search-record="${escapeHTML(record.id)}" aria-pressed="${String(record.id)===selection.selected}"><span class="search-record-top"><strong>${escapeHTML(actorName(record))}</strong>${statusMarkup(record)}</span><span class="search-record-query">${escapeHTML(record.query)}</span><span class="search-record-bottom"><span>${escapeHTML(platformName(record))}${record.status==='completed' ? ` · ${countLabel(resultCount(record),'result')}` : ''}</span><time>${preciseTime(record.started_at)}</time></span></button>`).join('') : `<div class="search-empty"><strong>${records().length ? 'No matching searches' : 'Waiting for trader searches'}</strong><p>${records().length ? 'Choose another trader or platform to view other searches.' : 'Searches and results appear here when traders use a search tool.'}</p></div>`;
    }
    const record=selection.inspection ? records().find(record=>String(record.id)===selection.inspection) : visible.find(record=>String(record.id)===selection.selected);
    const nextDetailKey=JSON.stringify([record || null,record && actorName(record),record && platformName(record),selection.inspection,focused]);
    if(detailKey!==nextDetailKey){
      detailKey=nextDetailKey;
      $('#socialSearchDetail').innerHTML=record ? `${selection.inspection ? `<div class="source-inspection"><strong>Inspecting ${escapeHTML(actorName(record))}’s search</strong><span>${escapeHTML(personName(focused))}’s terminal remains selected.</span><button type="button" class="record-link" data-close-source-inspection>Return to ${escapeHTML(personName(focused))}’s research ↗</button></div>` : ''}<button type="button" class="search-back" data-search-back>‹ Back to search history</button><div class="search-detail-heading"><div><span class="search-detail-platform">${escapeHTML(platformName(record))} · ${escapeHTML(actorName(record))}</span><h4>${escapeHTML(record.query)}</h4></div>${statusMarkup(record)}</div><div class="search-detail-meta"><span>Started ${preciseTime(record.started_at)}</span>${record.finished_at ? `<span>Finished ${preciseTime(record.finished_at)}</span>` : ''}${record.status==='completed' ? `<span>${countLabel(resultCount(record),'result')}</span>` : ''}</div><button type="button" class="search-trajectory-link" data-search-trajectory="${escapeHTML(record.id)}">View on market timeline ↗</button>${record.activity_id ? `<button type="button" class="search-trajectory-link" data-open-activity="${escapeHTML(record.activity_id)}">Open agent run ↗</button>` : ''}<button type="button" class="search-trajectory-link" data-return-terminal>Return to selected market event ↗</button><div class="social-results">${resultsMarkup(record)}</div>` : '<div class="search-detail-empty"><span aria-hidden="true">⌕</span><p>Select a search to view its results and sources.</p></div>';
    }
  }
  function renderAgent() {
    if(!$('#personDialog').open || !selectedAgentId) return;
    const own=records().filter(record=>record.actor_id===selection.selectedAgentId).slice(0,8);
    $('#agentSearchCount').textContent=`${countLabel(records().filter(record=>record.actor_id===selection.selectedAgentId).length,'search','searches')}`;
    $('#viewAgentSearches').disabled=!own.length;
    const key=JSON.stringify([selectedAgentId,own]);
    if(key===agentKey) return;
    const sameAgent=renderedAgentId===selection.selectedAgentId;
    const expanded=new Set(sameAgent ? $$('#agentSearchRecords details[open]').map(element=>element.dataset.agentSearch) : []);
    agentKey=key; renderedAgentId=selectedAgentId;
    $('#agentSearchRecords').innerHTML=own.length ? own.map((record,index)=>`<details class="agent-search-record" data-agent-search="${escapeHTML(record.id)}" ${expanded.has(String(record.id)) || (!sameAgent && index===0) ? 'open' : ''}><summary><span class="agent-search-record-top"><span>${escapeHTML(platformName(record))} · ${preciseTime(record.started_at)}</span>${statusMarkup(record)}</span><strong>${escapeHTML(record.query)}</strong></summary><div class="agent-search-results">${resultsMarkup(record)}<button type="button" class="agent-search-open" data-open-agent-search="${escapeHTML(record.id)}">Open in search history ↗</button></div></details>`).join('') : '<div class="search-empty"><strong>No searches yet</strong><p>Results appear here when this trader uses a search tool.</p></div>';
  }
  function update(nextState,isConnected) {
    connected=isConnected;
    if(cacheSession!==focus.session) {cacheSession=focus.session;recordCache.clear();}
    if(nextState?.social_search) {data=nextState.social_search;(data.records || []).forEach(record=>recordCache.set(String(record.id),record));}
    focus.registerSearches(records()); render(); renderAgent();
  }
  function open({actorId=null,recordId=null}={}) {
    focus.inspectSearch({actorId,recordId});
    if($('#personDialog').open) $('#personDialog').close();
    window.marketAnalytics?.open('search');
    $('#socialSearchWorkspace').classList.toggle('show-detail',!!(selection.selected || selection.inspection));
    listKey=''; detailKey=''; render();
  }
  $('#openSocialSearch').addEventListener('click',()=>open());
  $('#viewAgentSearches').addEventListener('click',()=>open({actorId:selectedAgentId,recordId:records().find(record=>record.actor_id===selection.selectedAgentId)?.id}));
  $('#socialActorFilter').addEventListener('change',event=>{focus.setSearchFilter({actor:event.target.value});$('#socialSearchWorkspace').classList.remove('show-detail');render();});
  $('#socialPlatformFilter').addEventListener('change',event=>{focus.setSearchFilter({platform:event.target.value});$('#socialSearchWorkspace').classList.remove('show-detail');render();});
  $('#followLatestSearch').addEventListener('click',()=>{focus.followLatestSearch();render();$('#socialSearchWorkspace').classList.add('show-detail');$('.analytics-content').scrollTop=0;});
  document.addEventListener('click',event=>{
    const button=event.target.closest('button');
    if(!button || button.disabled) return;
    if(button.hasAttribute('data-close-source-inspection')) {focus.closeSearchInspection();detailKey='';render();}
    if(button.hasAttribute('data-return-terminal')) window.terminalUI?.show('overview');
    if(button.dataset.searchTrajectory) window.terminalUI?.openEvent(`search:${button.dataset.searchTrajectory}`);
    if(button.dataset.searchRecord){focus.selectSearch(button.dataset.searchRecord);render();$('#socialSearchWorkspace').classList.add('show-detail');$('.analytics-content').scrollTop=0;}
    if(button.hasAttribute('data-search-back')) $('#socialSearchWorkspace').classList.remove('show-detail');
    if(button.hasAttribute('data-expand-result')){
      const expanded=button.closest('.social-result').classList.toggle('expanded');
      button.setAttribute('aria-expanded',String(expanded));button.textContent=expanded ? 'Show less' : 'Show more';
    }
    if(button.dataset.openAgentSearch) open({actorId:selectedAgentId,recordId:button.dataset.openAgentSearch});
    if(button.dataset.sharedSearch) open({actorId:button.dataset.searchActor,recordId:button.dataset.sharedSearch});
  });
  window.socialSearchUI={update,render,renderAgent,open,records,ingest(items){items.forEach(record=>recordCache.set(String(record.id),record));focus.registerSearches(records());render();},setActor(){filterKey=''; render();}};
  update(state,online);
})();
