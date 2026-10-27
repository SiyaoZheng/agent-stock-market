'use strict';

(() => {
  const panel = $('#analyticsPanel');
  const focus = window.observerState;
  let market = null, hoverKey = null, chart = null;
  let chartKey = '', tableKey = '', tabsKey = '', ledgerKey = '', lastDetailKey = '';
  const fmt = (value, digits = 2) => Number.isFinite(Number(value)) ? Number(value).toLocaleString('en-US', {minimumFractionDigits:digits,maximumFractionDigits:digits}) : '—';
  const sign = (value, digits = 2) => `${Number(value) > 0 ? '+' : ''}${fmt(value,digits)}`;
  const tone = value => Number(value) > 0 ? 'profit' : Number(value) < 0 ? 'loss' : 'unchanged';
  const stock = () => market?.stocks.find(item => item.symbol === focus.symbol);
  const name = id => market?.accounts.find(item => item.actor_id === id)?.name || personName(id);
  const canInspect = id => state?.personas.some(item => item.id === id);
  const person = id => canInspect(id) ? `<button type="button" data-inspect-trader="${escapeHTML(id)}">${escapeHTML(name(id))} <span aria-hidden="true">↗</span></button>` : escapeHTML(name(id));
  const returnRate = account => account.initial_equity > 0 ? account.pnl / account.initial_equity * 100 : account.pnl_percent ?? 0;

  function series(item) {
    if (!item) return [];
    const rows = (item.history || []).map((row,index) => ({...row,index,ts:Date.parse(row.time),key:String(row.trade_id || `${item.symbol}-${index}`),quantity:row.volume})).filter(row => Number.isFinite(row.ts) && Number.isFinite(Number(row.price))).sort((a,b) => a.ts - b.ts || a.index - b.index);
    let previous = item.initial_price;
    rows.forEach(row => { row.price_change = row.price_change ?? Number(row.price) - previous; previous = Number(row.price); });
    const start = Date.parse(item.started_at);
    if (Number.isFinite(start) && Number.isFinite(Number(item.initial_price))) rows.unshift({key:'initial',initial:true,ts:start,time:item.started_at,price:Number(item.initial_price),quantity:0});
    return rows;
  }
  function stepPath(points) {
    return points.map((point,index) => index ? `H${point.x.toFixed(2)}V${point.y.toFixed(2)}` : `M${point.x.toFixed(2)},${point.y.toFixed(2)}`).join('');
  }
  function sparkline(item) {
    const points = series(item);
    if (!points.length) return '';
    const width = 140, height = 30, pad = 3;
    const prices = points.map(point => Number(point.price));
    const min = Math.min(...prices), max = Math.max(...prices), range = Math.max(max-min,0.02);
    const firstTime = points[0].ts, duration = points.at(-1).ts - firstTime;
    const mapped = points.map(point => ({x:duration ? pad+(point.ts-firstTime)/duration*(width-pad*2) : width/2,y:max === min ? height/2 : height-pad-(point.price-min)/range*(height-pad*2)}));
    const last = mapped.at(-1);
    return `<svg class="stock-sparkline ${tone(item.change)}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHTML(item.name)} trade price history"><path d="${stepPath(mapped)}"/><circle cx="${last.x.toFixed(2)}" cy="${last.y.toFixed(2)}" r="2"/></svg>`;
  }
  function select(next) {
    if (!market?.stocks.some(item => item.symbol === next)) return;
    if(!focus.selectSymbol(next)) return; hoverKey = null; chartKey = ''; ledgerKey = ''; lastDetailKey = '';
    render();
  }
  function open(preferredView = 'prices') {
    window.terminalUI?.show(preferredView === 'search' ? 'research' : 'overview');
    if (preferredView === 'accounts') window.terminalUI?.showData('accounts');
    render(true);
    window.socialSearchUI?.render();
  }
  function selectTrade(id, notify = true) {
    if(!focus.selectTrade(id)) return;
    window.marketUI?.select(focus.symbol,false);
    hoverKey=null; chartKey=''; lastDetailKey=''; render(true);
    if(notify) window.terminalUI?.focusTrade(id,true);
  }
  function markEvent() { hoverKey=null; chartKey=''; render(true); }
  function setActor() { tableKey = ''; chartKey = ''; render(true); }
  function notifySelection() { const point = currentPoint(); if (point?.trade_id) window.terminalUI?.focusTrade(point.trade_id, true); }
  function update(nextState, connected, preferredSymbol) {
    if (nextState?.market) market = nextState.market;


    $('#analyticsConnection').textContent = !connected ? 'Reconnecting' : nextState?.running ? 'Live' : 'Traders paused';
    $('#analyticsConnection').classList.toggle('offline',!connected);
    render();
  }
  function render(force = false) {
    if (!market || !panel.offsetWidth) return;
    const item = stock();
    if (!item) return;
    $('#priceChartHeading').textContent = `${item.name} / ${item.symbol}`;
    $('#analysisPrice').textContent = fmt(item.last_price);
    $('#analysisPrice').className = tone(item.change);
    $('#analysisChange').textContent = `${sign(item.change)} / ${sign(item.change_percent)}%`;
    $('#analysisChange').className = tone(item.change);
    $('#analysisTradeCount').textContent = fmt(item.history?.length || 0,0);
    $('#analysisVolume').textContent = fmt(item.volume,0);
    $('#analysisLastTrade').textContent = item.history?.length ? `Last trade ${preciseTime(item.history.at(-1).time)}` : 'Waiting for first trade';
    const prices = (item.history || []).map(row => Number(row.price));
    $('#analysisHigh').textContent = prices.length ? fmt(Math.max(...prices)) : '—';
    $('#analysisLow').textContent = prices.length ? fmt(Math.min(...prices)) : '—';
    $('#chartFocusLabel').textContent = focus.actor() ? `${name(focus.actor())}’s executions highlighted` : 'All executions';
    const nextChartKey = JSON.stringify([focus.symbol,focus.actor(),focus.chartMarker,item.started_at,item.initial_price,item.history]);
    if (force || chartKey !== nextChartKey) { chartKey = nextChartKey; hoverKey = null; renderChart(item); }
    renderAccounts(); renderLedger(item);
  }
  function renderChart(item) {
    const container = $('#priceChart');
    const rows = series(item);
    if (!rows.length) { container.innerHTML = '<p class="chart-empty">Waiting for an opening quote and the first trade.</p>'; chart = null; $('#tradeDetail').innerHTML = ''; return; }
    const width = Math.max(280,Math.floor(container.clientWidth)), height = width < 430 ? 254 : 276;
    const margin = {left:54,right:20,top:18,bottom:90};
    const prices = rows.map(row => Number(row.price));
    const rawMin = Math.min(...prices), rawMax = Math.max(...prices);
    const padding = Math.max((rawMax-rawMin)*0.13,0.015);
    const rough = (rawMax-rawMin+padding*2)/4;
    const power = 10 ** Math.floor(Math.log10(rough));
    const unit = rough/power;
    const step = (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10) * power;
    const min = Math.max(0,Math.floor((rawMin-padding)/step)*step);
    const max = Math.ceil((rawMax+padding)/step)*step;
    const eventTime = focus.chartMarker ? Date.parse(focus.chartMarker.time) : NaN;
    const start = Math.min(rows[0].ts, Number.isFinite(eventTime) ? eventTime : rows[0].ts), end = Math.max(rows.at(-1).ts, Number.isFinite(eventTime) ? eventTime : rows.at(-1).ts), duration = end-start;
    const plotWidth = width-margin.left-margin.right, plotHeight = height-margin.top-margin.bottom;
    const y = price => margin.top + (max-price)/(max-min)*plotHeight;
    const x = ts => duration ? margin.left+(ts-start)/duration*plotWidth : margin.left+plotWidth/2;
    const points = rows.map(row => ({...row,x:x(row.ts),y:y(row.price)}));
    const yTicks = [];
    for (let value=min;value<=max+step/10;value+=step) yTicks.push(value);
    const count = width < 440 ? 3 : 5;
    const times = duration ? Array.from({length:count},(_,index)=>start+duration*index/(count-1)) : [start];
    const baseline = Number(item.initial_price);
    const grid = yTicks.map(value=>`<line x1="${margin.left}" x2="${width-margin.right}" y1="${y(value)}" y2="${y(value)}" class="price-grid"/><text x="${margin.left-9}" y="${y(value)+3}" text-anchor="end" class="axis-label">${fmt(value)}</text>`).join('');
    const ticks = times.map((value,index)=>`<text x="${x(value)}" y="${height-9}" text-anchor="${duration && index===0 ? 'start' : duration && index===times.length-1 ? 'end' : 'middle'}" class="axis-label">${preciseTime(value)}</text>`).join('');
    const origin = Number.isFinite(baseline) ? `<line class="initial-price-line" x1="${margin.left}" x2="${width-margin.right}" y1="${y(baseline)}" y2="${y(baseline)}"/>` : '';
    const dots = points.map(point=>`<circle class="trade-hit" data-chart-key="${escapeHTML(point.key)}" cx="${point.x}" cy="${point.y}" r="9" role="button" tabindex="0" aria-label="${escapeHTML(point.initial ? `Opening quote ${fmt(point.price)}` : `${point.trade_id || ''}, ${preciseTime(point.time)}, buyer ${name(point.buyer_id)}, seller ${name(point.seller_id)}, ${fmt(point.quantity,0)} shares at ${fmt(point.price)}`)}"/><circle class="trade-point${point.initial ? ' origin-point' : ''}${focus.actor() && (point.buyer_id === focus.actor() || point.seller_id === focus.actor()) ? ' personal-point' : ''}" cx="${point.x}" cy="${point.y}" r="${point.initial ? 4 : focus.actor() && (point.buyer_id === focus.actor() || point.seller_id === focus.actor()) ? 5 : 3}"/>`).join('');
    const maxVolume = Math.max(...points.map(point => Number(point.quantity) || 0), 1);
    const volumeBottom = height - 30;
    const volumes = points.filter(point => !point.initial).map(point => `<rect class="volume-bar ${point.price_change < 0 ? 'negative' : ''}" x="${point.x - 3}" y="${volumeBottom - (point.quantity / maxVolume) * 38}" width="6" height="${Math.max(1,(point.quantity / maxVolume) * 38)}"/>`).join('');
    const marker = Number.isFinite(eventTime) ? `<line class="event-marker" x1="${x(eventTime)}" x2="${x(eventTime)}" y1="${margin.top}" y2="${volumeBottom}"/><circle class="event-marker-dot" cx="${x(eventTime)}" cy="${margin.top + 4}" r="4"/>` : '';
    $('#chartEventNote').hidden = !focus.chartMarker;
    $('#chartEventNote').textContent = focus.chartMarker ? `${preciseTime(focus.chartMarker.time)} · ${focus.chartMarker.label}` : '';
    container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="group" aria-label="${escapeHTML(item.name)} trade price chart"><title>${escapeHTML(item.name)} price history from the opening quote to the latest trade</title>${grid}${origin}${volumes}${marker}<text x="${margin.left}" y="${height - 72}" class="axis-label">Volume</text><path class="price-step" d="${stepPath(points)}"/>${dots}${ticks}<g id="chartCursor" pointer-events="none"><line id="chartCursorLine" y1="${margin.top}" y2="${height-margin.bottom}"/><circle id="chartCursorDot" r="5"/></g></svg>`;
    chart = {points,width,height,margin};
    renderSelection();
  }
  function currentPoint() {
    return chart?.points.find(point=>point.key === (hoverKey || focus.chartTradeId)) || chart?.points.at(-1);
  }
  function renderSelection() {
    if (!chart) return;
    const point = currentPoint();
    if (!point) return;
    const line = $('#chartCursorLine'), dot = $('#chartCursorDot');
    line?.setAttribute('x1',point.x); line?.setAttribute('x2',point.x);
    dot?.setAttribute('cx',point.x); dot?.setAttribute('cy',point.y);
    const following = focus.followingTrade;
    $('#followLatestTrade').classList.toggle('following',following);
    $('#followLatestTrade').setAttribute('aria-pressed',String(following));
    $('#followLatestTrade').textContent = following ? 'Following latest' : 'Follow latest trade';
    const key = JSON.stringify([focus.symbol,point,following,market.accounts.map(account=>[account.actor_id,account.name])]);
    if (lastDetailKey === key) return;
    lastDetailKey = key;
    $('#chartTradeSummary').textContent = point.initial ? `Opening reference · ${fmt(point.price)} credits` : `${point.trade_id} · ${preciseTime(point.time)} · ${name(point.buyer_id)} bought ${fmt(point.quantity,0)} shares from ${name(point.seller_id)} at ${fmt(point.price)} · Δ ${sign(point.price_change)}`;
    if (point.initial) {
      $('#tradeDetail').innerHTML = `<span class="trade-detail-label">Opening quote</span><time>${preciseTime(point.time)}</time><strong class="detail-price">${fmt(point.price)}<small>credits</small></strong><p class="initial-note">Reference price at the start of trading</p>`;
      return;
    }
    const direction = point.aggressor_side === 'buy' ? 'Buyer initiated' : point.aggressor_side === 'sell' ? 'Seller initiated' : 'Initiator';
    $('#tradeDetail').innerHTML = `<div class="trade-detail-label"><span>${focus.chartTradeId && !hoverKey ? 'Selected trade' : 'Trade details'}</span><span>${escapeHTML(point.trade_id || '')}</span></div><time>${preciseTime(point.time)}</time><strong class="detail-price">${fmt(point.price)}<small>credits</small></strong><div class="trade-volume">${fmt(point.quantity,0)} shares traded</div><div class="trade-change"><span>Price change</span><strong class="${tone(point.price_change)}">${sign(point.price_change)}</strong></div><dl class="trade-parties"><div><dt>Buyer</dt><dd>${person(point.buyer_id)}</dd></div><div><dt>Seller</dt><dd>${person(point.seller_id)}</dd></div><div><dt>${direction}</dt><dd>${point.aggressor_id ? person(point.aggressor_id) : '—'}</dd></div></dl>`;
    $$('#tradeLedgerBody tr').forEach(row=>row.classList.toggle('selected',row.dataset.ledgerKey===point.key));
  }
  function renderLedger(item) {
    const trades = series(item).filter(point=>!point.initial).reverse();
    const key = JSON.stringify([focus.symbol,trades]);
    if (ledgerKey === key) return;
    ledgerKey = key;
    $('#ledgerCount').textContent = fmt(trades.length,0);
    $('#tradeLedgerBody').innerHTML = trades.length ? trades.map(point=>`<tr data-ledger-key="${escapeHTML(point.key)}"><td><button type="button" data-select-trade="${escapeHTML(point.key)}" aria-label="View trade ${escapeHTML(point.trade_id || point.key)}">${preciseTime(point.time)}</button></td><td>${fmt(point.price)}</td><td>${fmt(point.quantity,0)}</td><td>${escapeHTML(name(point.buyer_id))}</td><td>${escapeHTML(name(point.seller_id))}</td><td class="${tone(point.price_change)}">${sign(point.price_change)}</td></tr>`).join('') : '<tr><td colspan="6" class="empty-ledger">Waiting for the first trade.</td></tr>';
  }
  function renderAccounts() {
    const order = $('#accountSort').value;
    const accounts = (market.accounts || []).filter(account=>!account.system && (!focus.actor() || account.actor_id === focus.actor()));
    const key = JSON.stringify([order,accounts]);
    if (tableKey === key) return;
    tableKey = key;
    accounts.sort((a,b)=>order==='name' ? a.name.localeCompare(b.name,'en-US') : order==='equity_desc' ? b.equity-a.equity || a.name.localeCompare(b.name,'en-US') : (order==='return_asc' ? 1 : -1)*(returnRate(a)-returnRate(b)) || a.name.localeCompare(b.name,'en-US'));
    const maximum = Math.max(...accounts.map(account=>Math.abs(returnRate(account))),0.0001);
    $('#accountAnalysisHeading').textContent = focus.actor() ? `${name(focus.actor())}’s account` : 'Holdings & returns';
    $('#accountAnalysisNote').textContent = focus.actor() ? 'Current holdings valued at the latest trade prices.' : `${accounts.length} participants · Ranked by total return`;
    $('#accountComparisonBody').innerHTML = accounts.map((account,index)=> {
      const rate = returnRate(account), length=Math.abs(rate)/maximum*44;
      return `<tr data-account-id="${escapeHTML(account.actor_id)}"><th scope="row"><span class="account-rank">${index+1}</span>${person(account.actor_id)}${account.actor_id==='adrian' ? '<span class="you-label">You</span>' : ''}</th><td>${fmt(account.cash)}</td><td>${fmt(account.positions?.QH || 0,0)}</td><td>${fmt(account.positions?.YS || 0,0)}</td><td>${fmt(account.equity)}</td><td class="${tone(account.pnl)}">${sign(account.pnl)}</td><td class="return-cell ${tone(rate)}"><span class="return-bar" aria-hidden="true"><i style="left:${rate < 0 ? 50-length : 50}%;width:${length}%"></i></span><strong>${sign(rate,4)}%</strong></td></tr>`;
    }).join('');
  }
  function nearest(event) {
    if (!chart) return null;
    const target = event.target.closest('[data-chart-key]');
    if (target) return chart.points.find(point=>point.key===target.dataset.chartKey);
    const svg = $('#priceChart svg');
    const rect = svg.getBoundingClientRect();
    const position = (event.clientX-rect.left)/rect.width*chart.width;
    if (position<chart.margin.left || position>chart.width-chart.margin.right) return null;
    const relativeY = (event.clientY-rect.top)/rect.height*chart.height;
    return chart.points.reduce((best,point)=> Math.abs(point.x-position)+Math.abs(point.y-relativeY)*0.12 < Math.abs(best.x-position)+Math.abs(best.y-relativeY)*0.12 ? point : best,chart.points[0]);
  }
  $('#accountSort').addEventListener('change',renderAccounts);
  $('#followLatestTrade').addEventListener('click',()=>{ focus.followLatestTrade(); hoverKey=null; lastDetailKey=''; render(true); notifySelection(); });
  $('#priceChart').addEventListener('pointermove',event=>{ if (event.pointerType==='touch') return; const point=nearest(event); hoverKey=point?.key || null; renderSelection(); });
  $('#priceChart').addEventListener('pointerleave',()=>{ hoverKey=null; renderSelection(); });
  $('#priceChart').addEventListener('click',event=>{ const point=nearest(event); if(point){ focus.selectTrade(point.key); hoverKey=null; render(true); notifySelection(); } });
  $('#priceChart').addEventListener('focusin',event=>{ if (event.target.dataset.chartKey) {hoverKey=event.target.dataset.chartKey; renderSelection();} });
  $('#priceChart').addEventListener('keydown',event=> {
    const target=event.target.closest('[data-chart-key]');
    if (!target || !chart) return;
    if(event.key==='Enter' || event.key===' ') {event.preventDefault(); focus.selectTrade(target.dataset.chartKey); hoverKey=null; render(true); $$('#priceChart [data-chart-key]').find(point=>point.dataset.chartKey===focus.chartTradeId)?.focus({preventScroll:true}); notifySelection();}
    if(['ArrowLeft','ArrowRight'].includes(event.key)) {
      event.preventDefault();
      const index=chart.points.findIndex(point=>point.key===target.dataset.chartKey);
      const next=Math.max(0,Math.min(chart.points.length-1,index+(event.key==='ArrowRight' ? 1 : -1)));
      const circles=$$('#priceChart [data-chart-key]'); circles[next]?.focus();
    }
  });
  document.addEventListener('click',event=> {
    const button=event.target.closest('button');
    if(!button || button.disabled) return;
    if(button.dataset.analysisStock) window.marketUI?.select(button.dataset.analysisStock);
    if(button.dataset.selectTrade) {selectTrade(button.dataset.selectTrade); panel.scrollIntoView({block:'nearest',behavior:'smooth'});}
    if(button.dataset.inspectTrader) {showPerson(button.dataset.inspectTrader);}
  });
  const resize = new ResizeObserver(()=>{if(panel.offsetWidth) render(true);});
  resize.observe($('#priceChart'));
  window.marketAnalytics={update,select,sparkline,open,selectTrade,markEvent,setActor,render,selection(){return {following:focus.followingTrade,tradeId:focus.chartTradeId || chart?.points.at(-1)?.trade_id,symbol:focus.symbol};}};
  update(state,online);
})();
