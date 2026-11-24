// Capture compositions before the editable fields hydrate.
export const PATH_INPUT_BOOT_SCRIPT = `(function(){
  document.addEventListener('compositionstart',function(e){
    var root=e.target.closest && e.target.closest('[data-path-input]');
    if(root) {
      var selection=document.getSelection && document.getSelection();
      function point(node,offset) {
        if(!node || !root.contains(node)) return null;
        var path=[];
        while(node!==root) { path.unshift(Array.prototype.indexOf.call(node.parentNode.childNodes,node)); node=node.parentNode; }
        return {path:path,offset:offset};
      }
      root.__pathCompositionStart={root:root.cloneNode(true),anchor:selection && point(selection.anchorNode,selection.anchorOffset),focus:selection && point(selection.focusNode,selection.focusOffset)};
      root.dataset.pathComposing='true';
    }
  },true);
  document.addEventListener('compositionend',function(e){
    var root=e.target.closest && e.target.closest('[data-path-input]');
    if(root) { delete root.dataset.pathComposing; delete root.__pathCompositionStart; }
  },true);
  document.addEventListener('blur',function(e){
    var root=e.target.closest && e.target.closest('[data-path-input]');
    if(root) { delete root.dataset.pathComposing; delete root.__pathCompositionStart; }
  },true);
})();`;
