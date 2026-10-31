// Scroll animation observer and the copy buttons. A file, not an inline
// <script>: CSP script-src 'self' (src/csp.js).
const observer = new IntersectionObserver((entries) => {
  entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('visible'); observer.unobserve(e.target); } });
}, { threshold: 0.1 });
document.querySelectorAll('.fade-in-section').forEach(s => observer.observe(s));

document.getElementById('cta-copy').addEventListener('click', function() {
  navigator.clipboard.writeText('npm install && npm start').then(() => {
    this.classList.add('copied');
    this.querySelector('span').textContent = 'copied!';
    setTimeout(() => { this.classList.remove('copied'); this.querySelector('span').textContent = 'npm install && npm start'; }, 1500);
  });
});

document.getElementById('proxy-cmd-copy').addEventListener('click', function() {
  const box = document.getElementById('proxy-cmd-box');
  navigator.clipboard.writeText('ANTHROPIC_BASE_URL=http://localhost:3456 claude').then(() => {
    box.classList.add('copied');
    setTimeout(() => { box.classList.remove('copied'); }, 1500);
  });
});

