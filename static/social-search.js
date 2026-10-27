'use strict';

(() => {
  let data = null, connected = false, actor = 'all', platform = 'all', selected = null, following = true;
  let filterKey = '', listKey = '', detailKey = '', agentKey = '', renderedAgentId = null;
  const records = () => Array.isArray(data?.records) ? data.records : [];
  const statusName = record => ({searching:'搜索中',completed:'已完成',error:'未完成'}[record.status] || '等待中');
  const resultCount = record => record.result_count ?? record.results?.length ?? 0;
  const platformName = record => record.platform_name || data?.platforms?.find(item=>item.id===record.platform)?.name || record.platform;
  const actorName = record => record.actor_name || personName(record.actor_id);
  const statusMarkup = record => `<span class="search-status ${['searching','completed','error'].includes(record.status) ? record.status : ''}">${statusName(record)}</span>`;
  const safeURL = safeSourceURL;
  function sourceDate(value) {
    if (!value) return '';
    const date = new Date(typeof value === 'number' ? value < 1e12 ? value*1000 : value : value);
    return Number.isNaN(date.getTime()) ? String(value).slice(0,50) : date.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
  }
  function metricsMarkup(metrics) {
    if (!metrics || typeof metrics !== 'object') return '';
    const names={likes:'点赞',like_count:'点赞',liked_count:'点赞',digg_count:'点赞',attitudes_count:'点赞',upvote_count:'赞同',comments:'评论',comment_count:'评论',comments_count:'评论',shares:'分享',share_count:'分享',reposts_count:'转发',repost_count:'转发',retweet_count:'转发',views:'浏览',view_count:'浏览',read_count:'阅读',play_count:'播放',favorites:'收藏',favorite_count:'收藏',collect_count:'收藏',collected_count:'收藏'};
    const seen=new Set();
    return Object.entries(metrics).filter(([key,value])=>names[key] && value!=null).map(([key,value])=> {
      if(seen.has(names[key])) return ''; seen.add(names[key]);
      const count=typeof value==='number' ? value.toLocaleString('zh-CN') : String(value).slice(0,30);
      return `<span>${escapeHTML(names[key])} ${escapeHTML(count)}</span>`;
    }).join('');
  }
  function resultMarkup(result,index) {
    const url=safeURL(result.url);
    const title=result.title || `搜索结果 ${index+1}`;
    const author=typeof result.author==='object' && result.author ? result.author.name || result.author.nickname || result.author.username || '' : result.author || '';
    const text=String(result.text || '');
    const published=sourceDate(result.published_at);
    return `<article class="social-result"><div class="social-result-heading"><span class="result-index">${index+1}</span><h4>${url ? `<a href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(title)} <span aria-hidden="true">↗</span></a>` : escapeHTML(title)}</h4></div>${author || published ? `<div class="social-result-meta">${author ? `<span>${escapeHTML(author)}</span>` : ''}${published ? `<time>${escapeHTML(published)}</time>` : ''}</div>` : ''}${text ? `<p class="social-result-text">${escapeHTML(text)}</p>` : ''}${text.length>90 ? '<button type="button" class="expand-result" data-expand-result aria-expanded="false">展开内容</button>' : ''}<div class="social-metrics">${metricsMarkup(result.metrics)}</div>${url ? `<a class="social-source-link" href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">查看来源 ↗</a>` : ''}</article>`;
  }
  function errorMarkup(error) {
    const message=String(error || '');
    const billing=message.match(/充值积分[：:]\s*(https?:\/\/[^\s<>"']+)/);
    const url=billing && safeURL(billing[1]);
    const detail=url ? message.replace(billing[0],'').trim() : message;
    return `${detail ? `<p>${escapeHTML(detail.slice(0,600))}</p>` : ''}${url ? `<a class="search-recharge" href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">充值积分 ↗</a>` : ''}`;
  }
  function resultsMarkup(record) {
    const items=Array.isArray(record.results) ? record.results : [];
    if(record.status==='searching' && !items.length) return '<div class="search-waiting"><span class="search-spinner" aria-hidden="true"></span><p>正在检索内容，结果返回后会自动显示。</p></div>';
    if(record.status==='error' && !items.length) return `<div class="search-failure"><strong>这次检索未完成</strong>${errorMarkup(record.error)}</div>`;
    if(!items.length) return '<div class="search-empty">这次搜索返回了 0 条结果。</div>';
    return `${record.status==='error' ? '<p class="search-partial-note">以下为已返回的结果。</p>' : ''}${items.map(resultMarkup).join('')}`;
  }
  function filteredRecords() { return records().filter(record=>(actor==='all' || String(record.actor_id)===actor) && (platform==='all' || String(record.platform)===platform)); }
  function renderFilters() {
    const people=new Map((state?.personas || []).map(person=>[String(person.id),person.name]));
    records().forEach(record=>people.set(String(record.actor_id),actorName(record)));
    const platforms=new Map((data?.platforms || []).map(item=>[String(item.id),item.name]));
    records().forEach(record=>platforms.set(String(record.platform),platformName(record)));
    if(actor!=='all' && !people.has(actor)) actor='all';
    if(platform!=='all' && !platforms.has(platform)) platform='all';
    const key=JSON.stringify([[...people],[...platforms]]);
    if(filterKey!==key){
      filterKey=key;
      $('#socialActorFilter').innerHTML='<option value="all">全部交易员</option>'+[...people].map(([id,name])=>`<option value="${escapeHTML(id)}">${escapeHTML(name)}</option>`).join('');
      $('#socialPlatformFilter').innerHTML='<option value="all">全部平台</option>'+[...platforms].map(([id,name])=>`<option value="${escapeHTML(id)}">${escapeHTML(name)}</option>`).join('');
    }
    $('#socialActorFilter').value=actor; $('#socialPlatformFilter').value=platform;
  }
  function render() {
    if(!$('#analyticsDialog').open || $('[data-analysis-panel="search"]').hidden) return;
    renderFilters();
    const provider=data?.provider || 'SocialDataX';
    $('#socialProviderStatus').textContent=!connected ? '正在重新连接' : data?.available ? `${provider} · ${data.platforms?.length || 0} 个渠道` : `${provider} · ${data ? '未连接' : '接入中'}`;
    $('#socialProviderStatus').classList.toggle('available',!!connected && !!data?.available);
    const visible=filteredRecords();
    if(following || !visible.some(record=>String(record.id)===selected)) selected=visible.length ? String(visible[0].id) : null;
    $('#socialRecordCount').textContent=`${visible.length} 次检索`;
    $('#followLatestSearch').disabled=!visible.length;
    $('#followLatestSearch').classList.toggle('following',following);
    $('#followLatestSearch').setAttribute('aria-pressed',String(following));
    $('#followLatestSearch').textContent=following ? '正在跟随最新' : '跟随最新';
    const nextListKey=JSON.stringify([selected,visible.map(record=>[record.id,record.actor_id,actorName(record),platformName(record),record.query,record.status,resultCount(record),record.started_at])]);
    if(nextListKey!==listKey){
      listKey=nextListKey;
      $('#socialSearchRecords').innerHTML=visible.length ? visible.map(record=>`<button type="button" class="search-record ${String(record.id)===selected ? 'selected' : ''}" data-search-record="${escapeHTML(record.id)}" aria-pressed="${String(record.id)===selected}"><span class="search-record-top"><strong>${escapeHTML(actorName(record))}</strong>${statusMarkup(record)}</span><span class="search-record-query">${escapeHTML(record.query)}</span><span class="search-record-bottom"><span>${escapeHTML(platformName(record))}${record.status==='completed' ? ` · ${resultCount(record)} 条` : ''}</span><time>${preciseTime(record.started_at)}</time></span></button>`).join('') : `<div class="search-empty"><strong>${records().length ? '这个筛选下还没有检索' : '等待交易员搜索'}</strong><p>${records().length ? '可以切换交易员或平台查看其他记录。' : '交易员调用搜索工具后，记录和结果会自动出现在这里。'}</p></div>`;
    }
    const record=visible.find(record=>String(record.id)===selected);
    const nextDetailKey=JSON.stringify(record || null);
    if(detailKey!==nextDetailKey){
      detailKey=nextDetailKey;
      $('#socialSearchDetail').innerHTML=record ? `<button type="button" class="search-back" data-search-back>‹ 返回搜索记录</button><div class="search-detail-heading"><div><span class="search-detail-platform">${escapeHTML(platformName(record))} · ${escapeHTML(actorName(record))}</span><h4>${escapeHTML(record.query)}</h4></div>${statusMarkup(record)}</div><div class="search-detail-meta"><span>检索于 ${preciseTime(record.started_at)}</span>${record.finished_at ? `<span>完成于 ${preciseTime(record.finished_at)}</span>` : ''}${record.status==='completed' ? `<span>${resultCount(record)} 条结果</span>` : ''}</div><div class="social-results">${resultsMarkup(record)}</div>` : '<div class="search-detail-empty"><span aria-hidden="true">⌕</span><p>选择一条检索，查看结果与来源。</p></div>';
    }
  }
  function renderAgent() {
    if(!$('#personDialog').open || !selectedAgentId) return;
    const own=records().filter(record=>record.actor_id===selectedAgentId).slice(0,8);
    $('#agentSearchCount').textContent=`${records().filter(record=>record.actor_id===selectedAgentId).length} 次`;
    $('#viewAgentSearches').disabled=!own.length;
    const key=JSON.stringify([selectedAgentId,own]);
    if(key===agentKey) return;
    const sameAgent=renderedAgentId===selectedAgentId;
    const expanded=new Set(sameAgent ? $$('#agentSearchRecords details[open]').map(element=>element.dataset.agentSearch) : []);
    agentKey=key; renderedAgentId=selectedAgentId;
    $('#agentSearchRecords').innerHTML=own.length ? own.map((record,index)=>`<details class="agent-search-record" data-agent-search="${escapeHTML(record.id)}" ${expanded.has(String(record.id)) || (!sameAgent && index===0) ? 'open' : ''}><summary><span class="agent-search-record-top"><span>${escapeHTML(platformName(record))} · ${preciseTime(record.started_at)}</span>${statusMarkup(record)}</span><strong>${escapeHTML(record.query)}</strong></summary><div class="agent-search-results">${resultsMarkup(record)}<button type="button" class="agent-search-open" data-open-agent-search="${escapeHTML(record.id)}">在信息检索中查看 ↗</button></div></details>`).join('') : '<div class="search-empty"><strong>还没有搜索记录</strong><p>这位交易员使用搜索工具后，结果会自动出现在这里。</p></div>';
  }
  function update(nextState,isConnected) {
    connected=isConnected;
    if(nextState?.social_search) data=nextState.social_search;
    render(); renderAgent();
  }
  function open({actorId='all',recordId=null}={}) {
    actor=String(actorId); platform='all'; selected=recordId==null ? null : String(recordId); following=!selected;
    if($('#personDialog').open) $('#personDialog').close();
    window.marketAnalytics?.open('search');
    $('#socialSearchWorkspace').classList.toggle('show-detail',!!selected);
    listKey=''; detailKey=''; render();
  }
  $('#openSocialSearch').addEventListener('click',()=>open());
  $('#viewAgentSearches').addEventListener('click',()=>open({actorId:selectedAgentId,recordId:records().find(record=>record.actor_id===selectedAgentId)?.id}));
  $('#socialActorFilter').addEventListener('change',event=>{actor=event.target.value;following=true;selected=null;$('#socialSearchWorkspace').classList.remove('show-detail');render();});
  $('#socialPlatformFilter').addEventListener('change',event=>{platform=event.target.value;following=true;selected=null;$('#socialSearchWorkspace').classList.remove('show-detail');render();});
  $('#followLatestSearch').addEventListener('click',()=>{following=true;selected=null;render();$('#socialSearchWorkspace').classList.add('show-detail');$('.analytics-content').scrollTop=0;});
  document.addEventListener('click',event=>{
    const button=event.target.closest('button');
    if(!button || button.disabled) return;
    if(button.dataset.searchRecord){selected=button.dataset.searchRecord;following=false;render();$('#socialSearchWorkspace').classList.add('show-detail');$('.analytics-content').scrollTop=0;}
    if(button.hasAttribute('data-search-back')) $('#socialSearchWorkspace').classList.remove('show-detail');
    if(button.hasAttribute('data-expand-result')){
      const expanded=button.closest('.social-result').classList.toggle('expanded');
      button.setAttribute('aria-expanded',String(expanded));button.textContent=expanded ? '收起内容' : '展开内容';
    }
    if(button.dataset.openAgentSearch) open({actorId:selectedAgentId,recordId:button.dataset.openAgentSearch});
    if(button.dataset.sharedSearch) open({actorId:button.dataset.searchActor,recordId:button.dataset.sharedSearch});
  });
  window.socialSearchUI={update,render,renderAgent,open};
  update(state,online);
})();
