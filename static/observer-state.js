'use strict';

(() => {
  const value = {
    session:null, perspective:'observer', traderId:null, workspace:'overview', dataPanel:'accounts', symbol:null,
    eventKey:null, chartTradeId:null, chartMarker:null, followingTrade:true, trajectoryFilter:'all', eventOffset:0,
  };
  const research = {actor:'all',platform:'all',selected:null,following:true,inspection:null};
  let people=[], symbols=[], platforms=[], trades=new Map(), eventList=[], eventIndex=new Map(), searches=[];
  const actor = () => value.perspective==='trader' ? value.traderId : null;
  const visibleEvents = () => eventList.filter(event=>(!actor() || event.actors.includes(actor())) && (value.trajectoryFilter==='all' || event.group===value.trajectoryFilter));
  const visibleSearches = () => searches.filter(record=>(research.actor==='all' || record.actor_id===research.actor) && (research.platform==='all' || record.platform===research.platform));
  const chooseLatestSearch = () => {if(research.following) research.selected=String(visibleSearches()[0]?.id || '') || null;};
  function resetResearch() {
    Object.assign(research,{actor:actor() || 'all',platform:'all',selected:null,following:true,inspection:null});
    chooseLatestSearch();
  }
  function exposeEvent(event) {
    if(value.trajectoryFilter!=='all' && value.trajectoryFilter!==event.group) value.trajectoryFilter='all';
    const index=visibleEvents().findIndex(item=>item.key===event.key);
    if(index>=0 && (index<value.eventOffset || index>=value.eventOffset+80)) value.eventOffset=Math.max(0,index-20);
  }
  function selectTrade(id) {
    const trade=trades.get(String(id));
    if(id!=='initial' && !trade) return false;
    if(trade) value.symbol=trade.symbol;
    value.chartTradeId=String(id); value.chartMarker=null; value.followingTrade=false;
    value.eventKey=trade ? `trade:${id}` : null;
    const event=eventIndex.get(value.eventKey);if(event) exposeEvent(event);
    return true;
  }
  function selectEvent(key) {
    const event=eventIndex.get(key);if(!event) return false;
    if(event.trade) return selectTrade(event.trade.id);
    value.eventKey=key; value.chartTradeId=null; value.followingTrade=false;
    value.chartMarker=Object.freeze({time:event.time,label:event.title});
    if(event.symbol && symbols.includes(event.symbol)) value.symbol=event.symbol;
    exposeEvent(event);return true;
  }
  function followLatestTrade() {
    value.chartTradeId=null; value.chartMarker=null; value.followingTrade=true;
    const latest=eventList.find(event=>event.trade && event.symbol===value.symbol);
    value.eventKey=latest?.key || null;
    if(latest) exposeEvent(latest);
  }
  function selectPerspective(mode,id=value.traderId) {
    if(!['observer','trader'].includes(mode) || (mode==='trader' && !people.includes(id))) return false;
    value.perspective=mode;value.traderId=people.includes(id) ? id : people[0] || null;
    value.trajectoryFilter='all';value.eventOffset=0;resetResearch();
    const visible=visibleEvents();
    const first=visible.find(event=>event.trade && event.symbol===value.symbol) || visible.find(event=>event.trade) || visible[0];
    if(first) selectEvent(first.key);else {value.eventKey=null;value.chartMarker=null;value.chartTradeId=null;value.followingTrade=false;}
    return true;
  }
  function selectSymbol(symbol) {
    if(!symbols.includes(symbol)) return false;
    value.symbol=symbol;followLatestTrade();return true;
  }
  function setTrajectoryFilter(filter) {
    if(!['all','activity','market','research','decision','message'].includes(filter)) return false;
    value.trajectoryFilter=filter;value.eventOffset=0;
    const first=visibleEvents()[0];
    if(first) selectEvent(first.key);else {value.eventKey=null;value.chartTradeId=null;value.chartMarker=null;value.followingTrade=false;}
    return true;
  }
  function registerEvents(events) {
    eventList=events;eventIndex=new Map(events.map(event=>[event.key,event]));
    // New records advance only an explicitly following chart. Pinned records keep their identity.
    if(value.followingTrade) {
      value.eventKey=events.find(event=>event.trade && event.symbol===value.symbol)?.key || null;
    } else if(value.chartMarker && eventIndex.has(value.eventKey)) {
      const selected=eventIndex.get(value.eventKey);
      value.chartMarker=Object.freeze({time:selected.time,label:selected.title});
    }
  }
  function registerSearches(records) {
    searches=records;
    if(!actor() && research.actor!=='all' && !people.includes(research.actor) && !records.some(record=>record.actor_id===research.actor)) research.actor='all';
    if(research.platform!=='all' && !platforms.includes(research.platform) && !records.some(record=>record.platform===research.platform)) research.platform='all';
    chooseLatestSearch();
  }
  function setSearchFilter(filter) {
    if(filter.actor!==undefined) research.actor=actor() || (people.includes(filter.actor) || searches.some(record=>record.actor_id===filter.actor) ? filter.actor : 'all');
    if(filter.platform!==undefined) research.platform=platforms.includes(filter.platform) || searches.some(record=>record.platform===filter.platform) ? filter.platform : 'all';
    research.following=true;research.inspection=null;chooseLatestSearch();
  }
  function selectSearch(id) {
    const record=searches.find(record=>String(record.id)===String(id));if(!record) return false;
    if(actor() && record.actor_id!==actor()) {research.inspection=String(id);return true;}
    research.selected=String(id);research.following=false;research.inspection=null;return true;
  }
  function inspectSearch({actorId=null,recordId=null}={}) {
    const record=searches.find(record=>String(record.id)===String(recordId));
    if(record && actor() && record.actor_id!==actor()) {research.inspection=String(record.id);return;}
    if(recordId!=null || actorId!=null) {
      research.actor=actor() || actorId || record?.actor_id || 'all';research.platform='all';research.inspection=null;
      research.selected=record ? String(record.id) : null;research.following=!record;
      chooseLatestSearch();
    }
  }
  function syncSession(snapshot) {
    if(!snapshot) return;
    people=(snapshot.personas || []).map(person=>person.id);
    symbols=(snapshot.market?.stocks || []).map(stock=>stock.symbol);
    platforms=(snapshot.social_search?.platforms || []).map(platform=>platform.id);
    trades=new Map((snapshot.market?.stocks || []).flatMap(stock=>(stock.history || []).map(trade=>[String(trade.trade_id),{...trade,symbol:stock.symbol}])));
    const key=snapshot.market?.stocks?.[0]?.started_at || snapshot.created_at;
    if(key && key!==value.session) {
      value.session=key;value.eventKey=null;value.chartTradeId=null;value.chartMarker=null;value.followingTrade=true;value.eventOffset=0;
      eventList=[];eventIndex.clear();searches=[];resetResearch();
    }
    if(!people.includes(value.traderId)) {value.traderId=people[0] || null;resetResearch();}
    if(!symbols.includes(value.symbol)) value.symbol=symbols[0] || null;
    if(actor()) research.actor=actor();
  }
  const readonly = source => Object.freeze(Object.defineProperties({},Object.fromEntries(Object.keys(source).map(key=>[key,{enumerable:true,get:()=>source[key]}]))));
  window.observerState=Object.freeze(Object.defineProperties({
    research:readonly(research),actor,syncSession,selectPerspective,selectSymbol,selectTrade,selectEvent,followLatestTrade,
    setTrajectoryFilter,registerEvents,registerSearches,setSearchFilter,selectSearch,inspectSearch,
    closeSearchInspection(){research.inspection=null;},
    followLatestSearch(){research.following=true;research.inspection=null;chooseLatestSearch();},
    setWorkspace(view){if(['overview','research','discussion'].includes(view)) value.workspace=view;},
    setDataPanel(panel){if(['accounts','book','trades','orders'].includes(panel)) value.dataPanel=panel;},
    movePage(direction){value.eventOffset=Math.max(0,Math.min(Math.max(0,visibleEvents().length-1),value.eventOffset+direction*80));},
  },Object.fromEntries(Object.keys(value).map(key=>[key,{enumerable:true,get:()=>value[key]}]))));
})();
