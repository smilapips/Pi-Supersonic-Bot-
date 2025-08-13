const stellar = require('stellar-sdk');
const bip39 = require('bip39');
const edHd = require('ed25519-hd-key');
const readline = require('readline');

const HORIZON_URL = 'https://api.mainnet.minepi.com';
const NETWORK_PASSPHRASE = 'Pi Network';
const CHECK_INTERVAL = 1000; // Retry every 1s
const fireBefore = 1200; // ms before unlock time

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function getInput(prompt) {
  return new Promise(resolve => rl.question(prompt, resolve));
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Fetch dynamic base fee (with congestion multiplier)
async function getDynamicBaseFee(server, multiplier = 1.0) {
  const feeStats = await server.feeStats();
  const minFee = Number(feeStats.fee_charged.min);
  const modeFee = Number(feeStats.fee_charged.mode);
  const p95Fee = Number(feeStats.fee_charged.p95);

  let fee = modeFee;

  if (p95Fee > modeFee * 2) {
    fee = Math.ceil(p95Fee * multiplier);
    console.log(`⚡ Network congestion detected. Using bumped fee of ${fee} stroops.`);
  } else if (multiplier > 1) {
    fee = Math.ceil(modeFee * multiplier);
    console.log(`⚡ Using custom multiplier. Fee per op: ${fee} stroops.`);
  } else {
    console.log(`ℹ️ Network normal. Using mode fee of ${fee} stroops.`);
  }
  return fee.toString();
}

(async () => {
  const mnemonic = await getInput('🔐 Enter your 24-word passphrase: ');
  const destination = await getInput('📥 Enter destination wallet address: ');
  const inputAmount = await getInput('💰 Enter amount to send per payment: ');
  const unlockTimeInput = await getInput('⏰ Enter unlock time (HH:MM:SS in UTC): ');
  rl.close();

  if (!bip39.validateMnemonic(mnemonic)) {
    console.error('❌ Invalid mnemonic.');
    process.exit(1);
  }

  const unlockParts = unlockTimeInput.split(':').map(Number);
  const now = new Date();
  const unlockTime = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    unlockParts[0],
    unlockParts[1],
    unlockParts[2]
  ));

  console.log(`📅 Scheduled unlock at: ${unlockTime.toISOString()}`);

  const msToUnlock = unlockTime - Date.now() - fireBefore;
  if (msToUnlock > 0) {
    console.log(`⏳ Scheduling first tx in ${msToUnlock} ms`);
    setTimeout(startSubmissionLoop, msToUnlock);
  } else {
    startSubmissionLoop();
  }

  function startSubmissionLoop() {
    submitTransaction();
    setInterval(submitTransaction, CHECK_INTERVAL);
  }

  const seed = await bip39.mnemonicToSeed(mnemonic);
  const derived = edHd.derivePath("m/44'/314159'/0'", seed);
  const keypair = stellar.Keypair.fromRawEd25519Seed(derived.key);
  const publicKey = keypair.publicKey();

  const server = new stellar.Horizon.Server(HORIZON_URL);

  async function submitTransaction() {
    try {
      const account = await server.loadAccount(publicKey);

      // Fetch dynamic base fee with 1.5x bump during congestion
      const baseFeeStroops = await getDynamicBaseFee(server, 1.5);

      // Fetch current claimable balances (only need the first one)
      const claimable = await server.claimableBalances()
        .claimant(publicKey)
        .order('desc')
        .limit(1)
        .call();

      const balances = claimable.records || [];
      const txBuilder = new stellar.TransactionBuilder(account, {
        fee: baseFeeStroops,
        networkPassphrase: NETWORK_PASSPHRASE
      });

      if (balances.length > 0) {
        const claimId = balances[0].id;
        for (let i = 0; i < 3; i++) {
          txBuilder.addOperation(stellar.Operation.claimClaimableBalance({
            balanceId: claimId
          }));
          txBuilder.addOperation(stellar.Operation.payment({
            destination,
            asset: stellar.Asset.native(),
            amount: parseFloat(inputAmount).toFixed(7)
          }));
          console.log(`📦 Adding claim+payment pair for balance: ${claimId}`);
        }
      } else {
        // No claims: just add three payments
        for (let i = 0; i < 3; i++) {
          txBuilder.addOperation(stellar.Operation.payment({
            destination,
            asset: stellar.Asset.native(),
            amount: parseFloat(inputAmount).toFixed(7)
          }));
          console.log(`💸 Adding payment (no claimable balance available for pair ${i + 1})`);
        }
      }

      const opCount = txBuilder.operations.length;
      if (opCount === 0) {
        console.warn('⚠️ No operations to submit.');
        return;
      }

      const tx = txBuilder.setTimeout(30).build();
      tx.sign(keypair);

      console.log(
        `📤 Submitting transaction with ${opCount} ops at ${baseFeeStroops} stroops/op (total: ${(Number(baseFeeStroops) * opCount / 1e7).toFixed(7)} Pi)`
      );

      const result = await server.submitTransaction(tx);

      console.log('✅ Success! Transaction submitted.');
      console.log('🔗 Tx link:', result._links?.transaction?.href);

    } catch (err) {
      const code = err.response?.data?.extras?.result_codes?.transaction;
      const opErrs = err.response?.data?.extras?.result_codes?.operations || [];

      if (err.response?.status === 429) {
        console.warn('⛔ Rate limited. Waiting 5s...');
        await wait(5000);
      } else if (code === 'tx_bad_seq') {
        console.warn('⚠️ Bad sequence. Retrying...');
      } else if (code === 'tx_insufficient_fee') {
        console.warn('💸 Fee too low. Consider increasing base fee.');
      } else if (opErrs.includes('op_underfunded')) {
        console.warn('❌ Underfunded payment. Skipping.');
      } else {
        console.error('❌ Unknown error:', err.response?.data || err.message);
      }
    }
  }
})();
