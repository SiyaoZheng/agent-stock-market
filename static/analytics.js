'use strict';

(() => {
  const dialog = $('#analyticsDialog');
  let market = null, symbol = null, pinnedKey = null, hoverKey = null, chart = null, view = 'prices';
  let chartKey = '', tableKey = '', tabsKey = '', ledgerKey = '', lastDetailKey = '';
  const fmt = (value, digits = 2) => Number.isFinite(Number(value)) ? Number(value).toLocaleString('zh-CN', {minimumFractionDigits:digits,maximumFractionDigits:digits}) : '—';
  const sign = (value, digits = 2) => `${Number(value) > 0 ? '+' : ''}${fmt(value,digits)}`;
  const tone = value => Number(value) > 0 ? 'profit' : Number(value) < 0 ? 'loss' : 'unchanged';
  const stock = () => market?.stocks.find(item => item.symbol === symbol);
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
    return `<svg class="stock-sparkline ${tone(item.change)}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHTML(item.name)}实际成交走势"><path d="${stepPath(mapped)}"/><circle cx="${last.x.toFixed(2)}" cy="${last.y.toFixed(2)}" r="2"/></svg>`;
  }
  function select(next) {
    if (!market?.stocks.some(item => item.symbol === next)) return;
    symbol = next; pinnedKey = null; hoverKey = null; chartKey = ''; ledgerKey = ''; lastDetailKey = '';
    render();
  }
  function open(preferredView) {
    if (!market) return;
    if (typeof preferredView === 'string') setView(preferredView);
    if (!dialog.open) dialog.showModal();
    render(true);
    window.socialSearchUI?.render();
  }
  function setView(nextView) {
    if (!['prices','accounts','search'].includes(nextView)) return;
    view = nextView;
    $$('[data-analytics-view]').forEach(item=>{const active=item.dataset.analyticsView===view; item.classList.toggle('selected',active); item.setAttribute('aria-pressed',String(active));});
    $$('[data-analysis-panel]').forEach(panel=>{panel.hidden=panel.dataset.analysisPanel!==view;});
    $('.analytics-content').scrollTop = 0;
    render(true);
    window.socialSearchUI?.render();
  }
  function update(nextState, connected, preferredSymbol) {
    if (nextState?.market) market = nextState.market;
    if (!symbol || !market?.stocks.some(item => item.symbol === symbol)) symbol = preferredSymbol || market?.stocks[0]?.symbol;
    $('#openAnalytics').disabled = !market;
    $('#analyticsConnection').textContent = !connected ? '连接重试中' : nextState?.running ? '实时更新' : '交易员已暂停';
    $('#analyticsConnection').classList.toggle('offline',!connected);
    if (dialog.open) render();
  }
  function render(force = false) {
    if (!dialog.open || !market) return;
    const item = stock();
    if (!item) return;
    const nextTabsKey = JSON.stringify([symbol,market.stocks.map(item => [item.symbol,item.name])]);
    if (tabsKey !== nextTabsKey) {
      tabsKey = nextTabsKey;
      $('#analyticsStockTabs').innerHTML = market.stocks.map(item => `<button type="button" data-analysis-stock="${escapeHTML(item.symbol)}" class="${item.symbol === symbol ? 'selected' : ''}" aria-pressed="${item.symbol === symbol}">${escapeHTML(item.name)} <span>${escapeHTML(item.symbol)}</span></button>`).join('');
    }
    $('#priceChartHeading').textContent = `${item.name} · 成交价格走势`;
    $('#analysisPrice').textContent = fmt(item.last_price);
    $('#analysisPrice').className = tone(item.change);
    $('#analysisChange').textContent = `${sign(item.change)} / ${sign(item.change_percent)}%`;
    $('#analysisChange').className = tone(item.change);
    $('#analysisTradeCount').textContent = fmt(item.history?.length || 0,0);
    $('#analysisVolume').textContent = fmt(item.volume,0);
    $('#analysisLastTrade').textContent = item.history?.length ? `最后成交 ${preciseTime(item.history.at(-1).time)}` : '等待首笔成交';
    const nextChartKey = JSON.stringify([symbol,item.started_at,item.initial_price,item.history]);
    if (view === 'prices' && (force || chartKey !== nextChartKey)) { chartKey = nextChartKey; hoverKey = null; renderChart(item); }
    renderAccounts(); renderLedger(item);
  }
  function renderChart(item) {
    const container = $('#priceChart');
    const rows = series(item);
    if (!rows.length) { container.innerHTML = '<p class="chart-empty">等待初始报价与首笔成交。</p>'; chart = null; $('#tradeDetail').innerHTML = ''; return; }
    const width = Math.max(280,Math.floor(container.clientWidth)), height = width < 430 ? 240 : 264;
    const margin = {left:54,right:20,top:18,bottom:32};
    const prices = rows.map(row => Number(row.price));
    const rawMin = Math.min(...prices), rawMax = Math.max(...prices);
    const padding = Math.max((rawMax-rawMin)*0.13,0.015);
    const rough = (rawMax-rawMin+padding*2)/4;
    const power = 10 ** Math.floor(Math.log10(rough));
    const unit = rough/power;
    const step = (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10) * power;
    const min = Math.max(0,Math.floor((rawMin-padding)/step)*step);
    const max = Math.ceil((rawMax+padding)/step)*step;
    const start = rows[0].ts, end = rows.at(-1).ts, duration = end-start;
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
    const dots = points.map(point=>`<circle class="trade-hit" data-chart-key="${escapeHTML(point.key)}" cx="${point.x}" cy="${point.y}" r="9" role="button" tabindex="0" aria-label="${escapeHTML(point.initial ? `初始报价 ${fmt(point.price)}` : `${point.trade_id || ''}，${preciseTime(point.time)}，${name(point.buyer_id)}买入、${name(point.seller_id)}卖出${fmt(point.quantity,0)}股，价格${fmt(point.price)}`)}"/><circle class="trade-point${point.initial ? ' origin-point' : ''}" cx="${point.x}" cy="${point.y}" r="${point.initial ? 4 : 3}"/>`).join('');
    container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="group" aria-label="${escapeHTML(item.name)}逐笔成交价格图"><title>${escapeHTML(item.name)}从初始报价到最新成交的价格走势</title>${grid}${origin}<path class="price-step" d="${stepPath(points)}"/>${dots}${ticks}<g id="chartCursor" pointer-events="none"><line id="chartCursorLine" y1="${margin.top}" y2="${height-margin.bottom}"/><circle id="chartCursorDot" r="5"/></g></svg>`;
    chart = {points,width,height,margin};
    if (pinnedKey && !points.some(point=>point.key===pinnedKey)) pinnedKey = null;
    renderSelection();
  }
  function currentPoint() {
    return chart?.points.find(point=>point.key === (hoverKey || pinnedKey)) || chart?.points.at(-1);
  }
  function renderSelection() {
    if (!chart) return;
    const point = currentPoint();
    if (!point) return;
    const line = $('#chartCursorLine'), dot = $('#chartCursorDot');
    line?.setAttribute('x1',point.x); line?.setAttribute('x2',point.x);
    dot?.setAttribute('cx',point.x); dot?.setAttribute('cy',point.y);
    const following = !pinnedKey;
    $('#followLatestTrade').classList.toggle('following',following);
    $('#followLatestTrade').setAttribute('aria-pressed',String(following));
    $('#followLatestTrade').textContent = following ? '正在跟随最新' : '跟随最新成交';
    const key = JSON.stringify([symbol,point,following,market.accounts.map(account=>[account.actor_id,account.name])]);
    if (lastDetailKey === key) return;
    lastDetailKey = key;
    if (point.initial) {
      $('#tradeDetail').innerHTML = `<span class="trade-detail-label">初始报价</span><time>${preciseTime(point.time)}</time><strong class="detail-price">${fmt(point.price)}<small>模拟元</small></strong><p class="initial-note">交易开始时的参考价格</p>`;
      return;
    }
    const direction = point.aggressor_side === 'buy' ? '主动买入' : point.aggressor_side === 'sell' ? '主动卖出' : '成交';
    $('#tradeDetail').innerHTML = `<div class="trade-detail-label"><span>${pinnedKey && !hoverKey ? '选中成交' : '成交详情'}</span><span>${escapeHTML(point.trade_id || '')}</span></div><time>${preciseTime(point.time)}</time><strong class="detail-price">${fmt(point.price)}<small>模拟元</small></strong><div class="trade-volume">成交 ${fmt(point.quantity,0)} 股</div><div class="trade-change"><span>本笔价格变化</span><strong class="${tone(point.price_change)}">${sign(point.price_change)}</strong></div><dl class="trade-parties"><div><dt>买方</dt><dd>${person(point.buyer_id)}</dd></div><div><dt>卖方</dt><dd>${person(point.seller_id)}</dd></div><div><dt>${direction}</dt><dd>${point.aggressor_id ? person(point.aggressor_id) : '—'}</dd></div></dl>`;
    $$('#tradeLedgerBody tr').forEach(row=>row.classList.toggle('selected',row.dataset.ledgerKey===point.key));
  }
  function renderLedger(item) {
    const trades = series(item).filter(point=>!point.initial).reverse();
    const key = JSON.stringify([symbol,trades]);
    if (ledgerKey === key) return;
    ledgerKey = key;
    $('#ledgerCount').textContent = fmt(trades.length,0);
    $('#tradeLedgerBody').innerHTML = trades.length ? trades.map(point=>`<tr data-ledger-key="${escapeHTML(point.key)}"><td><button type="button" data-select-trade="${escapeHTML(point.key)}" aria-label="查看成交 ${escapeHTML(point.trade_id || point.key)}">${preciseTime(point.time)}</button></td><td>${fmt(point.price)}</td><td>${fmt(point.quantity,0)}</td><td>${escapeHTML(name(point.buyer_id))}</td><td>${escapeHTML(name(point.seller_id))}</td><td class="${tone(point.price_change)}">${sign(point.price_change)}</td></tr>`).join('') : '<tr><td colspan="6" class="empty-ledger">等待首笔成交。</td></tr>';
  }
  function renderAccounts() {
    const order = $('#accountSort').value;
    const accounts = (market.accounts || []).filter(account=>!account.system);
    const key = JSON.stringify([order,accounts]);
    if (tableKey === key) return;
    tableKey = key;
    accounts.sort((a,b)=>order==='name' ? a.name.localeCompare(b.name,'zh-CN') : order==='equity_desc' ? b.equity-a.equity || a.name.localeCompare(b.name,'zh-CN') : (order==='return_asc' ? 1 : -1)*(returnRate(a)-returnRate(b)) || a.name.localeCompare(b.name,'zh-CN'));
    const maximum = Math.max(...accounts.map(account=>Math.abs(returnRate(account))),0.0001);
    $('#accountAnalysisNote').textContent = `${accounts.length} 位参与者 · 按最新成交价计算总资产与盈亏`;
    $('#accountComparisonBody').innerHTML = accounts.map((account,index)=> {
      const rate = returnRate(account), length=Math.abs(rate)/maximum*44;
      return `<tr data-account-id="${escapeHTML(account.actor_id)}"><th scope="row"><span class="account-rank">${index+1}</span>${person(account.actor_id)}${account.actor_id==='adrian' ? '<span class="you-label">你</span>' : ''}</th><td>${fmt(account.cash)}</td><td>${fmt(account.positions?.QH || 0,0)}</td><td>${fmt(account.positions?.YS || 0,0)}</td><td>${fmt(account.equity)}</td><td class="${tone(account.pnl)}">${sign(account.pnl)}</td><td class="return-cell ${tone(rate)}"><span class="return-bar" aria-hidden="true"><i style="left:${rate < 0 ? 50-length : 50}%;width:${length}%"></i></span><strong>${sign(rate,4)}%</strong></td></tr>`;
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
  $('#openAnalytics').addEventListener('click',open);
  $('#accountSort').addEventListener('change',renderAccounts);
  $('#followLatestTrade').addEventListener('click',()=>{ pinnedKey=null; hoverKey=null; lastDetailKey=''; renderSelection(); });
  $('#priceChart').addEventListener('pointermove',event=>{ if (event.pointerType==='touch') return; const point=nearest(event); hoverKey=point?.key || null; renderSelection(); });
  $('#priceChart').addEventListener('pointerleave',()=>{ hoverKey=null; renderSelection(); });
  $('#priceChart').addEventListener('click',event=>{ const point=nearest(event); if(point){ pinnedKey=point.key; hoverKey=null; renderSelection(); } });
  $('#priceChart').addEventListener('focusin',event=>{ if (event.target.dataset.chartKey) {hoverKey=event.target.dataset.chartKey; renderSelection();} });
  $('#priceChart').addEventListener('keydown',event=> {
    const target=event.target.closest('[data-chart-key]');
    if (!target || !chart) return;
    if(event.key==='Enter' || event.key===' ') {event.preventDefault(); pinnedKey=target.dataset.chartKey; hoverKey=null; renderSelection();}
    if(['ArrowLeft','ArrowRight'].includes(event.key)) {
      event.preventDefault();
      const index=chart.points.findIndex(point=>point.key===target.dataset.chartKey);
      const next=Math.max(0,Math.min(chart.points.length-1,index+(event.key==='ArrowRight' ? 1 : -1)));
      const circles=$$('#priceChart [data-chart-key]'); circles[next]?.focus();
    }
  });
  dialog.addEventListener('click',event=> {
    const button=event.target.closest('button');
    if(!button || button.disabled) return;
    if(button.dataset.analyticsView) setView(button.dataset.analyticsView);
    if(button.dataset.analysisStock) select(button.dataset.analysisStock);
    if(button.dataset.selectTrade) {pinnedKey=button.dataset.selectTrade; hoverKey=null; renderSelection(); $('.chart-and-trade').scrollIntoView({block:'nearest',behavior:'smooth'});}
    if(button.dataset.inspectTrader) {dialog.close(); showPerson(button.dataset.inspectTrader);}
  });
  const resize = new ResizeObserver(()=>{if(dialog.open) render(true);});
  resize.observe($('#priceChart'));
  dialog.addEventListener('close',()=>{hoverKey=null;});
  window.marketAnalytics={update,select,sparkline,open};
  update(state,online);
})();
