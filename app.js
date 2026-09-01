'use strict';

// ---------- Function selectors (from this project's own compiled contracts — never change) ----------
const NFT_MINT_SELECTOR = '0x1249c58b';    // mint()
const TOKEN_MINT_SELECTOR = '0xa0712d68';  // mint(uint256)

// ---------- Tiny amount helper (avoids pulling in a full BigNumber/ethers library) ----------
function parseUnits18(input) {
  const str = String(input).trim();
  if (!str || str.startsWith('-')) throw new Error('Invalid amount.');
  let [whole, frac = ''] = str.split('.');
  whole = whole.replace(/\D/g, '') || '0';
  frac = (frac.replace(/\D/g, '') + '0'.repeat(18)).slice(0, 18);
  return BigInt(whole) * 10n ** 18n + BigInt(frac || '0');
}
function toHex32(value) {
  return value.toString(16).padStart(64, '0');
}

// ---------- Data ----------
let SITE_DATA = null;
async function loadData() {
  const res = await fetch('data.json', { cache: 'no-store' });
  SITE_DATA = await res.json();
  document.querySelectorAll('[data-bind="siteTitle"]').forEach((el) => { el.textContent = SITE_DATA.settings.siteTitle; });
  document.querySelectorAll('[data-bind="tagline"]').forEach((el) => { el.textContent = SITE_DATA.settings.tagline; });
  document.title = SITE_DATA.settings.siteTitle;
}

// ---------- EIP-6963 multi-wallet discovery ----------
const discoveredProviders = []; // { info: {uuid,name,icon,rdns}, provider }
window.addEventListener('eip6963:announceProvider', (event) => {
  if (!discoveredProviders.some((p) => p.info.uuid === event.detail.info.uuid)) {
    discoveredProviders.push(event.detail);
  }
});
window.dispatchEvent(new Event('eip6963:requestProvider'));

let activeProvider = null;
let activeAccount = null;

async function pickProvider() {
  // Give EIP-6963 announcements a brief moment to arrive, then decide.
  await new Promise((r) => setTimeout(r, 150));
  if (discoveredProviders.length === 1) return discoveredProviders[0].provider;
  if (discoveredProviders.length > 1) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'wallet-picker-overlay';
      overlay.innerHTML = `<div class="wallet-picker">
        <p>Choose a wallet</p>
        ${discoveredProviders.map((p, i) => `<button data-i="${i}">${p.info.name}</button>`).join('')}
      </div>`;
      overlay.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-i]');
        if (btn) {
          document.body.removeChild(overlay);
          resolve(discoveredProviders[Number(btn.dataset.i)].provider);
        } else if (e.target === overlay) {
          document.body.removeChild(overlay);
          resolve(null);
        }
      });
      document.body.appendChild(overlay);
    });
  }
  // No EIP-6963 announcements — fall back to a legacy injected provider, if any.
  return window.ethereum || null;
}

async function connectWallet() {
  const provider = await pickProvider();
  if (!provider) {
    alert('No browser wallet found. Install MetaMask, Rabby, or a similar extension.');
    return null;
  }
  const accounts = await provider.request({ method: 'eth_requestAccounts' });
  activeProvider = provider;
  activeAccount = accounts[0];
  updateConnectButtons();
  return activeAccount;
}

function shortAddress(addr) {
  return addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : '';
}

function updateConnectButtons() {
  const label = activeAccount ? shortAddress(activeAccount) : 'Connect wallet';
  const connectBtn = document.getElementById('connect-btn');
  if (connectBtn) {
    connectBtn.textContent = label;
    connectBtn.classList.toggle('connected', !!activeAccount);
  }
  const mintConnectBtn = document.getElementById('mint-connect-btn');
  const mintActionBtn = document.getElementById('mint-action-btn');
  if (mintConnectBtn && mintActionBtn) {
    if (activeAccount) {
      mintConnectBtn.style.display = 'none';
      mintActionBtn.style.display = 'inline-block';
    } else {
      mintConnectBtn.style.display = 'inline-block';
      mintActionBtn.style.display = 'none';
    }
  }
}

document.getElementById('connect-btn').addEventListener('click', () => connectWallet());
document.getElementById('mint-connect-btn').addEventListener('click', () => connectWallet());

// ---------- Network switch/add ----------
async function ensureChain(entry) {
  const currentHex = await activeProvider.request({ method: 'eth_chainId' });
  const desiredHex = '0x' + entry.chainId.toString(16);
  if (currentHex.toLowerCase() === desiredHex.toLowerCase()) return;
  try {
    await activeProvider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: desiredHex }] });
  } catch (switchErr) {
    if (switchErr && switchErr.code === 4902) {
      await activeProvider.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: desiredHex,
          chainName: entry.networkName,
          rpcUrls: [entry.rpcUrl],
          nativeCurrency: { name: entry.currencySymbol, symbol: entry.currencySymbol, decimals: 18 },
          blockExplorerUrls: entry.explorerUrl ? [entry.explorerUrl] : []
        }]
      });
    } else {
      throw switchErr;
    }
  }
}

// ---------- Mint ----------
async function mint(entry) {
  const statusEl = document.getElementById('mint-status');
  const actionBtn = document.getElementById('mint-action-btn');
  statusEl.className = 'mint-status';
  statusEl.textContent = '';
  actionBtn.disabled = true;
  try {
    await ensureChain(entry);
    const data = entry.kind === 'nft'
      ? NFT_MINT_SELECTOR
      : TOKEN_MINT_SELECTOR + toHex32(parseUnits18(entry.mintAmount));

    statusEl.textContent = 'Confirm the transaction in your wallet...';
    const txHash = await activeProvider.request({
      method: 'eth_sendTransaction',
      params: [{ from: activeAccount, to: entry.address, data }]
    });
    statusEl.className = 'mint-status success';
    statusEl.innerHTML = entry.explorerUrl
      ? `Submitted — <a href="${entry.explorerUrl}/tx/${txHash}" target="_blank" rel="noopener">view transaction</a>.`
      : `Submitted — ${txHash}`;
  } catch (err) {
    statusEl.className = 'mint-status error';
    statusEl.textContent = err?.message || 'Something went wrong sending that transaction.';
  } finally {
    actionBtn.disabled = false;
  }
}

// ---------- Routing ----------
function render() {
  const hash = location.hash || '#/';
  const pieceMatch = hash.match(/^#\/piece\/(.+)$/);
  if (pieceMatch) {
    renderPiece(pieceMatch[1]);
  } else {
    renderCatalog();
  }
}

function renderCatalog() {
  document.getElementById('view-catalog').style.display = '';
  document.getElementById('view-piece').style.display = 'none';
  const grid = document.getElementById('catalog-grid');
  const emptyNote = document.getElementById('catalog-empty');
  grid.innerHTML = '';
  const entries = SITE_DATA.entries;
  emptyNote.style.display = entries.length ? 'none' : '';
  entries.forEach((entry, i) => {
    const a = document.createElement('a');
    a.href = `#/piece/${entry.contractId}`;
    a.className = 'catalog-card';
    a.innerHTML = `
      <span class="lot-number">Lot ${String(i + 1).padStart(3, '0')}</span>
      ${entry.imageFile ? `<img src="assets/${entry.imageFile}" alt="${entry.title}" />` : ''}
      <span class="card-title">${entry.title}</span>
      <span class="card-kind">${entry.kind === 'nft' ? 'Collectible' : 'Token'} · ${entry.networkName}</span>
    `;
    grid.appendChild(a);
  });
}

function renderPiece(contractId) {
  const entry = SITE_DATA.entries.find((e) => e.contractId === contractId);
  if (!entry) { location.hash = '#/'; return; }
  document.getElementById('view-catalog').style.display = 'none';
  document.getElementById('view-piece').style.display = '';

  const index = SITE_DATA.entries.indexOf(entry);
  document.getElementById('piece-lot').textContent = `Lot ${String(index + 1).padStart(3, '0')}`;
  document.getElementById('piece-title').textContent = entry.title;
  document.getElementById('piece-meta').textContent =
    `${entry.kind === 'nft' ? 'Collectible' : 'Token'} · ${entry.networkName} · ${entry.symbol}`;
  document.getElementById('piece-desc').textContent = entry.description || '';
  const img = document.getElementById('piece-image');
  img.src = entry.imageFile ? `assets/${entry.imageFile}` : '';
  img.alt = entry.title;
  document.getElementById('mint-status').textContent = '';
  document.getElementById('mint-status').className = 'mint-status';

  updateConnectButtons();
  document.getElementById('mint-action-btn').onclick = () => mint(entry);
}

window.addEventListener('hashchange', render);

loadData().then(render);
