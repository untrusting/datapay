const mingo = require("mingo");
const bitcoin = require('bsv');
const _Buffer = bitcoin.deps.Buffer;
const Bitails = require("bitails");

/**
 * Builds a hex formatted transaction object.
 * @param {Object} options - The options for building the transaction.
 * @param {Function} callback - The callback function to handle results.
 */
const build = (options, callback) => {
	let script = null;
	const network = options.testnet ? "testnet" : "mainnet";
	const explorer = new Bitails(network);
	let tx = new bitcoin.Tx();
	let builder = new bitcoin.TxBuilder(tx);

	// Set the fee per kilobyte for the transaction
	builder.setFeePerKbNum(options.pay && options.pay.fee ? options.pay.fee : 50);
	builder.dust = 0;

	// If a partially signed transaction is provided, import it and check if it can be modified
	if (options.tx) {
		tx = typeof options.tx === "string" ?
			bitcoin.Tx.fromHex(options.tx) :
			bitcoin.Tx.fromBr(new bitcoin.Br(options.tx));

		if (tx.txIns.length > 0 && tx.txIns[0].script) {
			builder.importPartiallySignedTx(tx);

			// If the transaction is already signed and cannot be modified, return an error
			if((options.pay || options.data)) {
				callback(new Error("The transaction is already signed and cannot be modified"));
				return;
			}
		} else {
			builder.txOuts = tx.txOuts;
			builder.txOutsVi = tx.txOuts.Vi;
		}
	} else if (options.data) {
		// If data is provided, create a script with it
		script = _script(options);
	}

	// If a private key is provided, get the address and utxos for the transaction
	if (options.pay && options.pay.key) {
		const privateKey = bitcoin.PrivKey.fromString(options.pay.key);
		const address = bitcoin.Address.fromPrivKey(privateKey);

		explorer.utxos(address.toString()).then((res) => {
			// If there are no UTXOs available, return an error
			if (!res.unspent || !res.unspent.length) {
				callback(new Error("Empty wallet, no UTXOs"));
				return;
			}

			// Make the signed transaction
			_makeTransaction(builder, address, script, options, res.unspent, callback);
		});
	} else {
		// Make the unsigned transaction
		_makeTransaction(builder, undefined, script, options, [], callback);
	}
}

/**
 * Send a Bitcoin transaction using the provided options and callback.
 *
 * @param {Object} options - Options to configure the transaction.
 * @param {Function} [callback] - Optional callback function to handle the response.
 */
const send = (options, callback = () => {}) => {
	// Build the transaction
	build(options, (err, tx) => {
		if (err) {
			callback(err);
			return;
		}

		// Determine the network based on the testnet option
		const network = options.testnet ? 'test' : 'main';

		// Initialize the explorer with the selected network
		const explorer = new Bitails(network);

		// Broadcast the transaction and handle the response
		explorer.broadcast(tx.toHex()).then((res) => {
			callback(null, res);
		}).catch((e) => {
			callback(e, null);
		});
	});
};

/**
 * Builds a Bitcoin transaction using the given inputs and options.
 * @param {Object} builder - The transaction builder object.
 * @param {Object} address - The address object.
 * @param {Object} lockingScript - The locking script object.
 * @param {Object} options - The options object.
 * @param {Array} utxos - The array of UTXOs to use as inputs.
 * @param {Function} callback - The function to call when the transaction is built.
 */
const _makeTransaction = (builder, address, lockingScript, options, utxos, callback) => {
	// Check if an address is provided and if there are utxos available for the transaction
	if(address && utxos.length > 0) {
		// If there is a filter query in the options, apply it to the UTXOs
		if (options.pay.filter && options.pay.filter.q && options.pay.filter.q.find) {
			const query = new mingo.Query(options.pay.filter.q.find);
			utxos = utxos.filter(item => query.test(item));
		}

		// Calculate the total amount of UTXOs
		const totalAmount = utxos.reduce((total, utxo) => total + (utxo.value || utxo.satoshis), 0);

		// Calculate the required amount for the transaction if options.pay.to is provided
		let requiredAmount = 0;
		if (options.pay && options.pay.to && Array.isArray(options.pay.to)) {
			requiredAmount = options.pay.to.reduce((total, receiver) => total + receiver.value, 0);
		}

		// If the total amount of UTXOs is less than the required amount, return an error
		if (totalAmount < requiredAmount) {
			callback(new Error("Insufficient funds"));
			return;
		}
	}

    // If there is a locking script provided, add it to the transaction
    if (lockingScript) {
        builder.outputToScript(new bitcoin.Bn(0), lockingScript);
    }

    // If there is nData provided, add it to the transaction
    if (options.nData) {
        options.nData.forEach(data => {
            try {
                builder.outputToScript(new bitcoin.Bn(0), _script({ data: data }));
            } catch (error) {
                callback(new Error(error.message));
            }
        });
    }

    // If there are payment receivers provided, add them to the transaction
    if (options.pay && Array.isArray(options.pay.to)) {
        options.pay.to.forEach(receiver => {
            const destinationAddress = options.testnet ? bitcoin.Address.Testnet.fromString(receiver.address) : bitcoin.Address.fromString(receiver.address);
            builder.outputToAddress(new bitcoin.Bn(receiver.value), destinationAddress);
        });
    }

    // Build the outputs for the transaction
    builder.buildOutputs();

	// If an address is provided and there are utxos available, proceed with building and signing the transaction
	if(address && utxos.length > 0) {
		// Add inputs to the transaction from the UTXOs
		utxos.forEach(utxo => {
			const fundTxOut = bitcoin.TxOut.fromProperties(
				new bitcoin.Bn(utxo.value || utxo.satoshis),
				address.toTxOutScript()
			);
			const fundTxHashBuf = _Buffer.from(utxo.tx_hash || utxo.txid, 'hex').reverse();
			builder.inputFromPubKeyHash(fundTxHashBuf, utxo.tx_pos || utxo.vout, fundTxOut);
		});

		// Set the change address for the transaction
		builder.setChangeAddress(address);

		// Build the transaction
		builder.build({ useAllInputs: false });

		// Sign the transaction with the private key
		try {
			const keyPairs = [];
			const privateKey = options.testnet ? bitcoin.PrivKey.Testnet.fromString(options.pay.key) : bitcoin.PrivKey.Mainnet.fromString(options.pay.key);
			keyPairs.push(options.testnet ? bitcoin.KeyPair.Testnet.fromPrivKey(privateKey) : bitcoin.KeyPair.Mainnet.fromPrivKey(privateKey));
			builder.signWithKeyPairs(keyPairs);
		} catch (error) {
			callback(new Error(error.message));
		}
	}

    // Return the built transaction
    const ret = options.format === "hex" ? builder.tx.toHex() : builder.tx;
    callback(null, ret);
}

/**
 * Compose a Bitcoin script from the given options.
 *
 * @param {Object} options - Options to configure the script.
 * @returns {bitcoin.Script|null} The composed Bitcoin script or null if no data provided.
 */
const _script = (options) => {
	let s = null;

	if (options.data) {
		if (Array.isArray(options.data)) {
			s = new bitcoin.Script();
			options.safe = options.hasOwnProperty("safe") ? options.safe : true;

			if (options.safe) {
				s.writeOpCode(bitcoin.OpCode.OP_FALSE);
			}

			// Add OP_RETURN
			s.writeOpCode(bitcoin.OpCode.OP_RETURN);

			// Process each item in the data array
			options.data.forEach((item) => {
				if (item instanceof ArrayBuffer) {
					s.writeBuffer(_Buffer.Buffer.from(item));
				} else if (item instanceof Buffer) {
					s.writeBuffer(item);
				} else if (typeof item === 'string') {
					_handleStringData(item, s);
				} else if (typeof item === 'object' && item.hasOwnProperty('op')) {
					s.writeOpCode(item.op);
				}
			});
		} else if (typeof options.data === 'string') {
			// Exported transaction
			s = bitcoin.Script.fromString(options.data);
		}
	}

	return s;
};

/**
 * Handle string data and add it to the script.
 *
 * @param {string} item - String data to add to the script.
 * @param {bitcoin.Script} s - The script to add the data to.
 */
function _handleStringData(item, s) {
	if (/^0x/i.test(item)) {
		// ex: 0x6d02
		s.writeBuffer(Buffer.from(item.slice(2), "hex"));
	} else {
		// ex: "Hello, World!"
		s.writeBuffer(Buffer.from(item));
	}
}

const connect = (network = "main") => {
	return new Bitails(network);
}

module.exports = {
	build: build,
	send: send,
	bsv: bitcoin,
	connect: connect
}