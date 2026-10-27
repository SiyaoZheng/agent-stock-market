'use strict';

(() => {
  const focus = window.observerState;
  let renderedSymbol = null;
  let market = null, side = 'buy', pending = false, marketOnline = false, lastOrderId = null;
  const cancelling = new Set();
  const markupCache = new Map();
  function markup(id, html) { if (markupCache.get(id) !== html) { markupCache.set(id,html); $(id).innerHTML = html; } }
  const number = (value, digits = 2) => Number.isFinite(Number(value)) ? Number(value).toLocaleString('en-US', {minimumFractionDigits:digits,maximumFractionDigits:digits}) : '—';
  const signed = value => `${Number(value) > 0 ? '+' : ''}${number(value)}`;
  const changeClass = value => Number(value) > 0 ? 'up' : Number(value) < 0 ? 'down' : 'flat';
  const currentStock = () => market?.stocks.find(stock => stock.symbol === focus.symbol);
  const isOpen = order => ['open','partially_filled'].includes(order.status);
  const statusName = order => ({open:'Awaiting fill',partially_filled:'Partially filled',filled:'Filled',cancelled:order.filled_quantity ? 'Partially filled · Remainder cancelled' : 'Cancelled'}[order.status] || order.status);
  const stockName = symbol => market?.stocks.find(stock => stock.symbol === symbol)?.name || symbol;

  function bestPrice() {
    const stock = currentStock();
    return stock ? (side === 'buy' ? stock.ask : stock.bid) ?? stock.last_price : null;
  }
  function useBestPrice() {
    const price = bestPrice();
    if ($('#orderType').value === 'market') $('#orderPrice').value = '';
    else if (price != null) $('#orderPrice').value = Number(price).toFixed(2);
    updateOrderForm();
  }
  function updateOrderForm() {
    const stock = currentStock();
    const marketOrder = $('#orderType').value === 'market';
    const quantity = Number($('#orderQuantity').value);
    const price = marketOrder ? bestPrice() : Number($('#orderPrice').value);
    $('#orderPrice').disabled = marketOrder || pending;
    $('#orderPrice').required = !marketOrder;
    $('#orderPrice').placeholder = marketOrder ? 'Market price' : 'Limit';
    $('#orderQuantity').disabled = pending;
    $('#orderType').disabled = pending;
    $('#useBestPrice').disabled = marketOrder || pending || !stock;
    $('#orderEstimate').textContent = price > 0 && quantity > 0 ? `Estimated value ${number(price * quantity)}` : 'Estimated value —';
    $('#orderTypeHint').textContent = marketOrder ? 'Matches against the current book. Any unfilled quantity is cancelled.' : 'Fills at your limit or better. Any remainder stays in the book.';
    $('#orderStockLabel').textContent = stock ? `${stock.name} · ${stock.symbol}` : '';
    const button = $('#placeOrderButton');
    button.textContent = pending ? 'Submitting…' : `${side === 'buy' ? 'Buy' : 'Sell'}${stock ? ` ${stock.name}` : ''}`;
    button.classList.toggle('sell',side === 'sell');
    button.disabled = pending || !marketOnline || !stock || !market?.my_account || !Number.isInteger(quantity) || quantity < 1 || quantity > 10000 || (!marketOrder && !(price > 0));
    $$('[data-order-side]').forEach(button => {
      button.disabled = pending;
      button.classList.toggle('selected',button.dataset.orderSide === side);
      button.setAttribute('aria-pressed',String(button.dataset.orderSide === side));
    });
  }
  function bookRows(levels, buy) {
    const depth = levels.slice(0,5);
    if (!depth.length) return '<p class="book-empty">No open orders</p>';
    const maximum = Math.max(...depth.map(level => level.quantity),1);
    return depth.map(level => `<div class="book-row" style="--depth:${Math.round(level.quantity / maximum * 100)}%">${buy ? `<span class="quantity">${number(level.quantity,0)}</span><span class="price">${number(level.price)}</span>` : `<span class="price">${number(level.price)}</span><span class="quantity">${number(level.quantity,0)}</span>`}</div>`).join('');
  }
  function positionRows(account) {
    return (market?.stocks || []).map(stock => `<div class="position-line"><strong>${escapeHTML(stock.name)}</strong><span>${number(account.positions?.[stock.symbol] || 0,0)} shares · available ${number(account.available_positions?.[stock.symbol] || 0,0)}</span></div>`).join('');
  }
  function renderAgentAccount() {
    const account = market?.accounts?.find(item => item.actor_id === selectedAgentId);
    $('#agentAccount').hidden = !account;
    if (!account) return;
    $('#agentAccount').innerHTML = `<h3>Simulated account</h3><div class="account-totals"><div><span>Available cash</span><strong>${number(account.available_cash)}</strong></div><div><span>Equity · P/L ${signed(account.pnl)}</span><strong>${number(account.equity)}</strong></div></div><div class="my-positions">${positionRows(account)}</div>`;
  }
  function renderOrders() {
    const orders = market?.my_orders || [];
    $('#openOrderCount').textContent = orders.filter(isOpen).length;
    $('#ordersList').innerHTML = orders.length ? orders.slice(0,20).map(order => `<article class="order-row"><div class="order-row-head"><strong class="${order.side === 'buy' ? 'up' : 'down'}">${order.side === 'buy' ? 'Buy' : 'Sell'} ${escapeHTML(stockName(order.symbol))}</strong><time>${preciseTime(order.created_at)}</time><span class="order-state">${escapeHTML(statusName(order))}</span></div><div class="order-row-detail"><span>${order.order_type === 'market' ? 'Market' : number(order.limit_price)} · ${number(order.quantity,0)} shares</span><span>Filled ${number(order.filled_quantity,0)}${order.average_fill_price != null ? ` @ ${number(order.average_fill_price)}` : ''}</span>${isOpen(order) ? `<button type="button" data-cancel-order="${escapeHTML(order.id)}" ${cancelling.has(String(order.id)) ? 'disabled' : ''}>${cancelling.has(String(order.id)) ? 'Cancelling…' : 'Cancel'}</button>` : ''}</div></article>`).join('') : '<p class="market-empty">No orders yet. Select a stock to place one.</p>';
    const latest = orders.find(order => String(order.id) === String(lastOrderId));
    if (latest) renderOrderFeedback(latest);
  }
  function renderOrderFeedback(order) {
    const label = `${order.side === 'buy' ? 'Buy' : 'Sell'} ${stockName(order.symbol)}`;
    const detail = order.filled_quantity ? `Filled ${number(order.filled_quantity,0)} shares at an average of ${number(order.average_fill_price)}` : 'Filled 0 shares';
    $('#orderFeedback').textContent = `${label}: ${statusName(order)}. ${detail}${order.reason ? `. ${order.reason}` : ''}`;
    $('#orderFeedback').hidden = false;
  }
  function renderTrades() {
    const trades = (market?.trades || []).filter(trade => trade.symbol === focus.symbol).slice(0,20);
    $('#tradesList').innerHTML = trades.length ? trades.map(trade => `<div class="trade-row" title="${escapeHTML(personName(trade.buyer_id))} Buy · ${escapeHTML(personName(trade.seller_id))} Sell"><time>${preciseTime(trade.time)}</time><strong>${number(trade.price)}</strong><span>${number(trade.quantity,0)} shares</span></div>`).join('') : '<p class="market-empty">Waiting for the first trade.</p>';
  }
  function render() {
    if (!market) { updateOrderForm(); return; }
    const firstLoad = renderedSymbol !== focus.symbol;
    renderedSymbol = focus.symbol;
    markup('#stockTabs',market.stocks.map(stock => `<button type="button" class="stock-tab ${stock.symbol === focus.symbol ? 'selected' : ''}" data-stock="${escapeHTML(stock.symbol)}" aria-pressed="${stock.symbol === focus.symbol}"><span class="stock-name">${escapeHTML(stock.name)}<span class="stock-code">${escapeHTML(stock.symbol)}</span></span><span class="stock-price-line ${changeClass(stock.change)}"><strong>${number(stock.last_price)}</strong><small>${signed(stock.change_percent)}%</small></span>${window.marketAnalytics?.sparkline(stock) || ''}</button>`).join(''));
    const stock = currentStock();
    if (!stock) return;
    $('#selectedStockName').textContent = stock.name;
    $('#selectedStockSymbol').textContent = stock.symbol;
    $('#selectedStockPrice').textContent = number(stock.last_price);
    $('#selectedStockPrice').className = changeClass(stock.change);
    $('#selectedStockChange').textContent = `${signed(stock.change)} (${signed(stock.change_percent)}%)`;
    $('#selectedStockChange').className = changeClass(stock.change);
    $('#stockVolume').textContent = `${number(stock.volume,0)} shares`;
    $('#overviewBookSymbol').textContent = focus.symbol;
    $('#overviewSpread').textContent = stock.ask != null && stock.bid != null ? `Spread ${number(stock.ask-stock.bid)}` : 'Spread —';
    const book = market.books?.[focus.symbol] || {bids:[],asks:[]};
    $('#bidBook').innerHTML = bookRows(book.bids || [],true);
    $('#askBook').innerHTML = bookRows(book.asks || [],false);
    $('#overviewBidBook').innerHTML = bookRows(book.bids || [],true);
    $('#overviewAskBook').innerHTML = bookRows(book.asks || [],false);
    const account = market.my_account;
    $('#availableCash').textContent = account ? number(account.available_cash) : '—';
    $('#accountEquity').textContent = account ? number(account.equity) : '—';
    $('#myPositions').innerHTML = account ? `${positionRows(account)}${account.reserved_cash ? `<div class="position-line"><span>Cash reserved for orders</span><span>${number(account.reserved_cash)}</span></div>` : ''}` : '';
    renderOrders(); renderTrades(); renderAgentAccount();
    if (firstLoad) useBestPrice(); else updateOrderForm();
    $('#marketUpdatedAt').textContent = `Updated ${preciseTime(new Date())}`;
  }
  function update(nextState, connected) {
    marketOnline = connected && !!nextState?.market;
    if (nextState?.market) market = nextState.market;
    $('#marketConnection').classList.toggle('offline',!marketOnline);
    $('#marketConnection').innerHTML = `<i></i>${marketOnline ? 'Connected' : market ? 'Reconnecting' : 'Waiting for exchange'}`;
    render();
    window.marketAnalytics?.update(nextState,connected,focus.symbol);
  }
  function select(next, updateChart = true) {
    if (!market?.stocks.some(item => item.symbol === next)) return;
    if(updateChart && !focus.selectSymbol(next)) return;
    if(next !== focus.symbol) return;
    lastOrderId = null; formError('orderError'); $('#orderFeedback').hidden = true;
    render(); useBestPrice(); if (updateChart) window.marketAnalytics?.render(true);
  }
  document.addEventListener('click', async event => {
    const button = event.target.closest('button');
    if (!button || button.disabled) return;
    if (button.dataset.stock) {
      select(button.dataset.stock); window.terminalUI?.onStockChange(button.dataset.stock);
    }
    if (button.dataset.orderSide) { side = button.dataset.orderSide; formError('orderError'); useBestPrice(); }
    if (button.dataset.marketView) {
      const view = button.dataset.marketView;
      $$('[data-market-view]').forEach(item => { item.classList.toggle('selected',item.dataset.marketView === view); item.setAttribute('aria-pressed',String(item.dataset.marketView === view)); });
      $('#ordersList').hidden = view !== 'orders'; $('#tradesList').hidden = view !== 'trades';
    }
    if (button.dataset.workspace) {
      const showMarket = button.dataset.workspace === 'market';
      document.body.classList.toggle('market-visible',showMarket);
      $$('[data-workspace]').forEach(item => { const selected = item.dataset.workspace === button.dataset.workspace; item.classList.toggle('selected',selected); item.setAttribute('aria-pressed',String(selected)); });
      if (!showMarket) scrollToLatest();
    }
    if (button.dataset.cancelOrder) {
      const id = button.dataset.cancelOrder;
      if (cancelling.has(id) || !marketOnline) return;
      cancelling.add(id); renderOrders(); formError('orderError');
      try {
        const order = await api(`market/orders/${encodeURIComponent(id)}/cancel`,{});
        await refresh(true);
        toast(order.status === 'cancelled' ? 'Unfilled quantity cancelled. Reserved cash or shares released.' : `Order status: ${statusName(order)}`);
      } catch(error) { formError('orderError',error.message); toast(error.message); }
      finally { cancelling.delete(id); renderOrders(); }
    }
  });
  $('#orderType').addEventListener('change',useBestPrice);
  $('#orderPrice').addEventListener('input',updateOrderForm);
  $('#orderQuantity').addEventListener('input',updateOrderForm);
  $('#useBestPrice').addEventListener('click',useBestPrice);
  $('#orderForm').addEventListener('submit',async event => {
    event.preventDefault();
    if (pending || !marketOnline || $('#placeOrderButton').disabled) return;
    const quantity = Number($('#orderQuantity').value);
    const orderType = $('#orderType').value;
    const price = orderType === 'limit' ? Number($('#orderPrice').value) : null;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10000 || (price != null && !(price > 0))) { formError('orderError','Enter a valid price and a whole number of shares from 1 to 10,000.'); return; }
    pending = true; lastOrderId = null; formError('orderError'); $('#orderFeedback').hidden = true; updateOrderForm();
    try {
      const result = await api('market/orders',{symbol:focus.symbol,side,order_type:orderType,quantity,limit_price:price});
      lastOrderId = result.order.id;
      await refresh(true);
      const order = result.order;
      const label = `${order.side === 'buy' ? 'Buy' : 'Sell'} ${stockName(order.symbol)}`;
      renderOrderFeedback(market.my_orders.find(item => String(item.id) === String(order.id)) || order);
      toast(`${label} · ${statusName(order)}`);
    } catch(error) { formError('orderError',error.message); }
    finally { pending = false; updateOrderForm(); }
  });
  window.marketUI = {update,renderAgentAccount,select};
  update(state,online);
})();
