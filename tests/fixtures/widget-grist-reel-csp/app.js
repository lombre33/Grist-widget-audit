grist.ready({ requiredAccess: 'read table', columns: ['Nom', 'Email'] });
grist.onRecords(function (records) {
  var liste = document.getElementById('liste');
  liste.textContent = '';
  records.forEach(function (r) {
    var li = document.createElement('li');
    li.textContent = r.Nom + ' — ' + r.Email;
    liste.appendChild(li);
  });
});
