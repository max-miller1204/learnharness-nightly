// Capture compositions before the editable fields hydrate.
export const PATH_INPUT_BOOT_SCRIPT = `(function(){
  document.addEventListener('compositionstart',function(e){
    var root=e.target.closest && e.target.closest('[data-path-input]');
    if(root) root.dataset.pathComposing='true';
  },true);
  document.addEventListener('compositionend',function(e){
    var root=e.target.closest && e.target.closest('[data-path-input]');
    if(root) delete root.dataset.pathComposing;
  },true);
})();`;
