window.cspGlobal = 'visible';
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('go').addEventListener('click', () => {
    document.getElementById('out').textContent = 'went';
  });
});
