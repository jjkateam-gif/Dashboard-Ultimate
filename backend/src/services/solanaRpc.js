const { Connection, Keypair, PublicKey, VersionedTransaction } = require('@solana/web3.js');
const bs58 = require('bs58');

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

const connection = new Connection(RPC_URL, {
  commitment: 'confirmed',
  confirmTransactionInitialTimeout: 60000,
});

function keypairFromSecret(secretBytes) {
  return Keypair.fromSecretKey(new Uint8Array(secretBytes));
}

function keypairFromBase58(base58Key) {
  const decoded = bs58.decode(base58Key);
  return Keypair.fromSecretKey(decoded);
}

async function sendAndConfirmTx(transaction, signers, opts = {}) {
  try {
    if (transaction instanceof VersionedTransaction) {
      transaction.sign(signers);
      const rawTx = transaction.serialize();
      const sig = await connection.sendRawTransaction(rawTx, {
        skipPreflight: false,
        maxRetries: 3,
        ...opts,
      });
      await connection.confirmTransaction(sig, 'confirmed');
      return sig;
    } else {
      const sig = await connection.sendTransaction(transaction, signers, {
        skipPreflight: false,
        maxRetries: 3,
        ...opts,
      });
      await connection.confirmTransaction(sig, 'confirmed');
      return sig;
    }
  } catch (err) {
    console.error('[SolanaRPC] Transaction error:', err.message);
    throw err;
  }
}

async function getSolBalance(publicKey) {
  const lamports = await connection.getBalance(new PublicKey(publicKey));
  return lamports / 1e9;
}

async function getTokenBalance(publicKey, mintAddress) {
  try {
    const { TOKEN_PROGRAM_ID } = require('@solana/web3.js');
    const accounts = await connection.getParsedTokenAccountsByOwner(
      new PublicKey(publicKey),
      { mint: new PublicKey(mintAddress) }
    );
    if (accounts.value.length === 0) return 0;
    return accounts.value[0].account.data.parsed.info.tokenAmount.uiAmount || 0;
  } catch {
    return 0;
  }
}

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

module.exports = {
  connection,
  keypairFromSecret,
  keypairFromBase58,
  sendAndConfirmTx,
  getSolBalance,
  getTokenBalance,
  RPC_URL,
  USDC_MINT,
  PublicKey,
  Keypair,
  VersionedTransaction,
};
