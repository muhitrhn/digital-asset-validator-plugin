import {
    PublicKey,
    Keypair,
    Transaction,
    SystemProgram,
    Connection
} from '@solana/web3.js';
import {
    getMerkleRollAccountSize
} from '../../tests/merkle-roll-serde';
import { hash, getProofOfAssetFromServer, getRootFromServer, checkProof } from '../../tests/merkle-tree';
import { Gummyroll, IDL as GUMMYROLL_IDL } from '../../target/types/gummyroll';
import { GummyrollCrud, IDL as GUMMYROLL_CRUD_IDL } from '../../target/types/gummyroll_crud';
import log from 'loglevel';
import { Program, Provider } from '@project-serum/anchor';
import NodeWallet from '@project-serum/anchor/dist/cjs/nodewallet';
import { GUMMYROLL_PROGRAM_ID, GUMMYROLL_CRUD_PROGRAM_ID } from './constants';
import { confirmTxOrThrow } from './utils';

export async function getProvider(endpoint: string, payer: Keypair) {
    console.log(endpoint);
    const connection = new Connection(endpoint);
    const provider = new Provider(
        connection,
        new NodeWallet(payer),
        {
            commitment: "confirmed",
            skipPreflight: true,
        }
    )
    await connection.requestAirdrop(payer.publicKey, 100e9);
    return provider;
}

async function loadGummyroll(provider: Provider): Promise<Program<Gummyroll>> {
    // only on non-localnet
    // return await Program.at(GUMMYROLL_PROGRAM_ID, provider) as Program<Gummyroll>
    return new Program(GUMMYROLL_IDL, GUMMYROLL_PROGRAM_ID, provider);
}

async function loadGummyrollCrud(provider: Provider): Promise<Program<GummyrollCrud>> {
    // return await Program.at(GUMMYROLL_CRUD_PROGRAM_ID, provider) as Program<GummyrollCrud>
    return new Program(GUMMYROLL_CRUD_IDL, GUMMYROLL_CRUD_PROGRAM_ID, provider);
}

async function getTreeAuthorityPDA(
    gummyrollCrud: Program<GummyrollCrud>,
    treeAddress: PublicKey,
    treeAdmin: PublicKey
) {
    const seeds = [
        Buffer.from("gummyroll-crud-authority-pda", "utf-8"),
        treeAddress.toBuffer(),
        treeAdmin.toBuffer(),
    ];
    return await PublicKey.findProgramAddress(
        seeds,
        gummyrollCrud.programId
    );
}

export async function initEmptyTree(
    provider: Provider,
    treeAdminKeypair: Keypair,
    maxDepth: number,
    maxBufferSize: number
): Promise<PublicKey> {
    const treeKeypair = Keypair.generate();
    const requiredSpace = getMerkleRollAccountSize(maxDepth, maxBufferSize);

    const gummyroll = await loadGummyroll(provider);
    const gummyrollCrud = await loadGummyrollCrud(provider);

    const allocGummyrollAccountIx = SystemProgram.createAccount({
        fromPubkey: treeAdminKeypair.publicKey,
        newAccountPubkey: treeKeypair.publicKey,
        lamports:
            await gummyroll.provider.connection.getMinimumBalanceForRentExemption(
                requiredSpace
            ),
        space: requiredSpace,
        programId: gummyroll.programId,
    });

    const [treeAuthorityPDA] = await getTreeAuthorityPDA(
        gummyrollCrud,
        treeKeypair.publicKey,
        treeAdminKeypair.publicKey
    );

    const createTreeTx = gummyrollCrud.instruction.createTree(
        maxDepth,
        maxBufferSize,
        {
            accounts: {
                authority: treeAdminKeypair.publicKey,
                authorityPda: treeAuthorityPDA,
                gummyrollProgram: gummyroll.programId,
                merkleRoll: treeKeypair.publicKey,
            },
            signers: [treeAdminKeypair],
        }
    );

    const tx = new Transaction().add(allocGummyrollAccountIx).add(createTreeTx);
    const createTreeTxId = await gummyroll.provider.send(
        tx,
        [treeAdminKeypair, treeKeypair],
        {
            commitment: "confirmed",
        }
    );
    log.info("Sent init empty transaction:", createTreeTxId);

    await confirmTxOrThrow(gummyroll.provider.connection, createTreeTxId);
    return treeKeypair.publicKey;
}

export async function appendMessage(
    provider: Provider,
    treeAdminKeypair: Keypair,
    treeAddress: PublicKey,
    message: string,
) {
    const gummyroll = await loadGummyroll(provider);
    const gummyrollCrud = await loadGummyrollCrud(provider);

    const [treeAuthorityPDA] = await getTreeAuthorityPDA(
        gummyrollCrud,
        treeAddress,
        treeAdminKeypair.publicKey
    );
    const signers = [treeAdminKeypair];
    const addIx = gummyrollCrud.instruction.add(Buffer.from(message), {
        accounts: {
            authority: treeAdminKeypair.publicKey,
            authorityPda: treeAuthorityPDA,
            gummyrollProgram: gummyroll.programId,
            merkleRoll: treeAddress,
        },
        signers,
    });

    const appendTxId = await gummyrollCrud.provider.send(new Transaction().add(addIx), signers, {
        commitment: "confirmed",
    });
    log.info("Sent append message transaction:", appendTxId);
    await confirmTxOrThrow(gummyroll.provider.connection, appendTxId);
}

export async function showProof(
    proofUrl: string,
    treeAddress: PublicKey,
    index: number,
) {
    const proofInfo = await getProofOfAssetFromServer(proofUrl, treeAddress, index);
    const root = new PublicKey(proofInfo.root).toString();
    const hash = new PublicKey(proofInfo.hash).toString();
    console.log(`Proof found for leaf at ${index} in tree ${treeAddress.toString()}`)
    console.log(`Root: ${root}`);
    console.log(`Current leaf hash: ${hash}`);
    console.log(`Proof:`);
    proofInfo.proof.map((node, index) => {
        console.log(`${index}: ${new PublicKey(node).toString()}`)
    });
}

export async function removeMessage(
    provider: Provider,
    proofUrl: string,
    treeAdminKeypair: Keypair,
    treeAddress: PublicKey,
    index: number,
    owner: PublicKey,
    message: string,
) {
    const gummyroll = await loadGummyroll(provider);
    const gummyrollCrud = await loadGummyrollCrud(provider);

    const proofInfo = await getProofOfAssetFromServer(proofUrl, treeAddress, index);
    const root = new PublicKey(proofInfo.root).toBuffer();
    const leafHash = getLeafHash(owner, message);

    if (new PublicKey(leafHash).toString() !== new PublicKey(proofInfo.hash).toString()) {
        console.log("Expected:", new PublicKey(proofInfo.hash).toString());
        console.log("Calculated:", new PublicKey(leafHash).toString());
        throw new Error("❌ Leaf message does not match what's in tree! ❌");
    }

    const nodeProof = proofInfo.proof.map((node) => ({
        pubkey: new PublicKey(node),
        isSigner: false,
        isWritable: false,
    }));
    const [treeAuthorityPDA] = await getTreeAuthorityPDA(
        gummyrollCrud,
        treeAddress,
        treeAdminKeypair.publicKey
    );
    const signers = [treeAdminKeypair];
    const removeIx = gummyrollCrud.instruction.remove(
        Array.from(root),
        Array.from(leafHash),
        index,
        {
            accounts: {
                authority: treeAdminKeypair.publicKey,
                authorityPda: treeAuthorityPDA,
                gummyrollProgram: gummyroll.programId,
                merkleRoll: treeAddress,
            },
            signers,
            remainingAccounts: nodeProof,
        }
    );
    const tx = new Transaction().add(removeIx);
    const removeTxId = await gummyrollCrud.provider.send(tx, signers, {
        commitment: "confirmed",
        skipPreflight: true,
    });

    log.info("Sent remove message transaction:", removeTxId);
    confirmTxOrThrow(gummyroll.provider.connection, removeTxId);
}

export async function transferMessageOwner(
    provider: Provider,
    proofUrl: string,
    treeAdminKeypair: Keypair,
    treeAddress: PublicKey,
    index: number,
    owner: PublicKey,
    newOwner: PublicKey,
    message: string,
) {
    const gummyroll = await loadGummyroll(provider);
    const gummyrollCrud = await loadGummyrollCrud(provider);

    const proofInfo = await getProofOfAssetFromServer(proofUrl, treeAddress, index);

    if (!checkProof(index, proofInfo.root, proofInfo.hash, proofInfo.proof)) {
        throw new Error("Hash did not match!")
    }

    const root = new PublicKey(proofInfo.root).toBuffer();
    const leafHash = getLeafHash(owner, message);

    if (new PublicKey(leafHash).toString() !== new PublicKey(proofInfo.hash).toString()) {
        console.log("Expected:", new PublicKey(proofInfo.hash).toString());
        console.log("Calculated:", new PublicKey(leafHash).toString());
        throw new Error("❌ This tx will fail, since the owner + message combo does not match what's in tree! ❌");
    }

    const nodeProof = proofInfo.proof.map((node) => ({
        pubkey: new PublicKey(node),
        isSigner: false,
        isWritable: false,
    }));

    const [treeAuthorityPDA] = await getTreeAuthorityPDA(
        gummyrollCrud,
        treeAddress,
        treeAdminKeypair.publicKey
    );
    const signers = [treeAdminKeypair];

    log.info("Submitting transfer");
    log.info(`${owner.toString()} -> ${newOwner.toString()}: "${message}"`)
    const transferIx = gummyrollCrud.instruction.transfer(
        Array.from(root),
        Buffer.from(message),
        index,
        {
            accounts: {
                authority: treeAdminKeypair.publicKey,
                authorityPda: treeAuthorityPDA,
                gummyrollProgram: gummyroll.programId,
                merkleRoll: treeAddress,
                newOwner: newOwner,
                owner: owner,
            },
            signers,
            remainingAccounts: nodeProof,
        }
    );
    const tx = new Transaction().add(transferIx);
    const transferTxId = await gummyrollCrud.provider.send(tx, signers, {
        commitment: "confirmed",
        skipPreflight: true,
    });

    log.info("Sent transfer message transaction:", transferTxId);
    confirmTxOrThrow(gummyroll.provider.connection, transferTxId);
}

function getLeafHash(owner: PublicKey | undefined, message: string) {
    return hash(owner?.toBuffer() ?? Buffer.alloc(32), Buffer.from(message));
}
