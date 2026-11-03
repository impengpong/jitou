window.addEventListener('error', function(e){
  try { chrome.runtime.sendMessage({type:'EXT_ERROR', src:'sidepanel', msg:e.message, file:e.filename, line:e.lineno, col:e.colno, stack:e.error && e.error.stack}); } catch(_){}
});
window.addEventListener('unhandledrejection', function(e){
  try { chrome.runtime.sendMessage({type:'EXT_ERROR', src:'sidepanel', msg:String(e.reason), stack:e.reason && e.reason.stack}); } catch(_){}
});
