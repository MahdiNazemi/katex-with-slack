// Saves options to chrome.storage
function save_options() {
  var delimiterstyle = document.getElementById('delimiterstyle').value;
  chrome.storage.sync.set({
    delimiterstyle: delimiterstyle,
  }, function() {
    var status = document.getElementById('status');
    status.textContent = 'Option saved.';
    setTimeout(function() {
      status.innerHTML = '&nbsp;';
    }, 1000);
  });
}

// Restores select box state using preferences stored in chrome.storage.
function restore_options() {
  chrome.storage.sync.get({
    delimiterstyle: 'A'
  }, function(items) {
    document.getElementById('delimiterstyle').value = items.delimiterstyle;
  });
}

document.addEventListener('DOMContentLoaded', restore_options);
document.getElementById('save').addEventListener('click', save_options);
