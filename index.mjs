import dotenv from 'dotenv'
import bs58 from 'bs58'
import { Connection, Keypair, Transaction, PublicKey, SystemProgram } from '@solana/web3.js'
import got from 'got'
import { Wallet } from '@project-serum/anchor'
import promiseRetry from 'promise-retry'
import { ASSOCIATED_TOKEN_PROGRAM_ID, Token, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import combinate from 'combinations-generator'

dotenv.config()

// This is a free Solana RPC endpoint. It may have ratelimit and sometimes
// invalid cache. I will recommend using a paid RPC endpoint.
const connection = new Connection('https://solana-api.projectserum.com')
const wallet = new Wallet(Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY || '')))

const mints = {
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  SOL: 'So11111111111111111111111111111111111111112',
  NANA: '6uZ7MRGGf3FJhzk9TUk3QRMR2fz83WY9BEVBukRvMRVX',
  TULIP: 'TuLipcqtGVXP9XR62wM8WWCm6a9vhLs7T1uoWBk6FDs',
  OXY: 'z3dn17yLaGMKffVogeFHQ9zWVcXgqgf3PQnDsNs2g6M',
}

// wsol account
const createWSolAccount = async () => {
  const wsolAddress = await Token.getAssociatedTokenAddress(
    ASSOCIATED_TOKEN_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    new PublicKey(mints.SOL),
    wallet.publicKey
  )

  const wsolAccount = await connection.getAccountInfo(wsolAddress)

  if (!wsolAccount) {
    const transaction = new Transaction({
      feePayer: wallet.publicKey,
    })
    const instructions = []

    instructions.push(
      await Token.createAssociatedTokenAccountInstruction(
        ASSOCIATED_TOKEN_PROGRAM_ID,
        TOKEN_PROGRAM_ID,
        new PublicKey(mints.SOL),
        wsolAddress,
        wallet.publicKey,
        wallet.publicKey
      )
    )

    // fund 1 sol to the account
    instructions.push(
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: wsolAddress,
        lamports: 1_000_000_000, // 1 sol
      })
    )

    instructions.push(
      // This is not exposed by the types, but indeed it exists
      Token.createSyncNativeInstruction(TOKEN_PROGRAM_ID, wsolAddress)
    )

    transaction.add(...instructions)
    transaction.recentBlockhash = await (await connection.getRecentBlockhash()).blockhash
    transaction.partialSign(wallet.payer)
    const result = await connection.sendTransaction(transaction, [wallet.payer])
    console.log({ result })
  }

  return wsolAccount
}

const getCoinQuote = async (query) => {
  const qs = new URLSearchParams(Object.entries(query))
  try {
    return await got.get(`https://quote-api.jup.ag/v1/quote?${qs}`).json()
  } catch (err) {
    throw new Error(err.response.body)
  }
}

const getTransaction = (route) => {
  return got
    .post('https://quote-api.jup.ag/v1/swap', {
      json: {
        route: route,
        userPublicKey: wallet.publicKey.toString(),
        // to make sure it doesnt close the sol account
        wrapUnwrapSOL: true,
      },
    })
    .json()
}

const getConfirmTransaction = async (txid) => {
  const res = await promiseRetry(
    async (retry, attempt) => {
      let txResult = await connection.getTransaction(txid, {
        commitment: 'confirmed',
      })

      if (!txResult) {
        const error = new Error('Transaction was not confirmed')
        error.txid = txid

        retry(error)
        return
      }
      return txResult
    },
    {
      retries: 40,
      minTimeout: 500,
      maxTimeout: 1000,
    }
  )
  if (res.meta.err) {
    throw new Error('Transaction failed')
  }
  return txid
}

// require wsol to start trading, this function create your wsol account and fund 1 SOL to it
// await createWSolAccount()

const initial = 10_000_000

const combinationsIterator = combinate(Object.keys(mints), 2)
const combinations = [...combinationsIterator]
await Promise.all(
  combinations.map(async (combination) => {
    const permutations = [combination, combination.slice().reverse()]
    await Promise.all(
      permutations.map(async (permutation) => {
        const [from, to] = permutation
        const opts = {
          inputMint: mints[from],
          outputMint: mints[to],
          amount: initial,
          slippage: 0.2,
          onlyDirectRoutes: true,
        }

        const {
          data: [route0],
        } = await getCoinQuote(opts)

        const { setupTransaction, swapTransaction, cleanupTransaction } = await getTransaction(
          route0
        )

        console.log({
          permutation,
          opts,
          txs: [setupTransaction, swapTransaction, cleanupTransaction].filter(Boolean).length,
          // setupTransaction,
          // swapTransaction,
          // cleanupTransaction,
        })
      })
    )
  })
)
