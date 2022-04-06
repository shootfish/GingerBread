require('dotenv/config.js');
const { ethers } = require('ethers');
const chalk = require('chalk');
const Joi = require('joi');
const EventEmitter = require('events');
const pangolin = require('./dex/pangolin.js');
const traderjoe = require('./dex/traderjoe.js');
const { abi: pangolinPairAbi } = require('@pangolindex/exchange-contracts/artifacts/contracts/pangolin-core/interfaces/IPangolinPair.sol/IPangolinPair.json');
const { abi: traderjoePairAbi } = require('@traderjoe-xyz/core/artifacts/contracts/traderjoe/interfaces/IJoePair.sol/IJoePair.json');
const flashSwap = require('./artifacts/contracts/FlashSwapper.sol/FlashSwapper.json');




/**
 * GingerBread is an arbitrage bot that runs on the AVALANCHE C-CHAIN
 * To configure it to run on another network, change the environment variables to point to a node running on another network
 * This bot only works when one of the tokens compared is the native coin of the network - in this case WAVAX is the native coin of the AVALANCHE C-CHAIN
 * @class
 */
class GingerBread extends EventEmitter {

  pangolinSwapRate = 0.3; // 0.3%
  traderjoeSwapRate = 0.3; // 0.3%

  /**
   * @param {Object} Token0 - should have properties 'address', 'symbol' and 'volume' - WAVAX
   * @param {Object} Token1 - should have properties 'address', 'symmbol' and 'volume' - ERC20 token
   */
  constructor(token0, token1) {
    /**
     * @function tokenSchema - to validate the token objects being used to initialize bot
     */
    const tokenSchema = Joi.object({
      'address': Joi.string().length(42).required(),
      'symbol': Joi.string().min(2).max(7).uppercase().required(),
      'volume': Joi.number().min(0).required()
    });
    const { value: Token0, error: Token0Error } = tokenSchema.validate(token0);
    const { value: Token1, error: Token1Error } = tokenSchema.validate(token1);
    if (Token0Error) throw new Error(Token0Error['details'][0]['message']);
    if (Token1Error) throw new Error(Token1Error['details'][0]['message']);

    // - initialize bot variables
    super();
    this.web3Provider = new ethers.providers.JsonRpcProvider(process.env.C_CHAIN_NODE);
    this.wallet = new ethers.Wallet(process.env.PRIVATE_KEY, this.web3Provider);
    this.token0 = Token0['address'];
    this.token0Symbol = Token0['symbol'];
    this.token1 = Token1['address'];
    this.token1Symbol = Token1['symbol'];
    this.flashSwapAddress = process.env.FLASH_SWAP_ADDRESS;
    this.TOKEN0_TRADE = Token0['volume'];
    this.TOKEN1_TRADE = Token1['volume'];
    this.FlashSwapContract = new ethers.Contract(process.env.FLASH_SWAP_ADDRESS, flashSwap['abi'], this.wallet);
  }


  /**
   * @async function for running the bot
   * @method bake
   */
  bake = async () => {

    // - load contracts from pangolin
    const PangolinFactory = new ethers.Contract(pangolin['ADDRESS'], pangolin['ABI'], this.wallet);
    const pangolinPairAddress = await PangolinFactory.getPair(this.token0, this.token1);
    const pangolinPair = new ethers.Contract(pangolinPairAddress, pangolinPairAbi, this.wallet);

    // - load contracts from traderjoe
    const TraderjoeFactory = new ethers.Contract(traderjoe['ADDRESS'], traderjoe['ABI'], this.wallet);
    const traderjoePairAddress = await TraderjoeFactory.getPair(this.token0, this.token1);
    const TraderjoePair = new ethers.Contract(traderjoePairAddress, traderjoePairAbi, this.wallet);


    /**
     * @async function to listen to newly mined block
     */
    this.web3Provider.on('block', async (blockNumber) => {
      try {
        console.log('\n>> ' + chalk.blue('Current block: ') + chalk.green.bold(blockNumber));
        
        // - get price from pangolin
        const pangolinReserves = await pangolinPair.getReserves();
        const pangolinReserve0 = Number(ethers.utils.formatUnits(pangolinReserves[0], 18));
        const pangolinReserve1 = Number(ethers.utils.formatUnits(pangolinReserves[1], 18));
        const pangolinPrice = pangolinReserve0 / pangolinReserve1;

        // - get price from tradejoe
        const traderjoeReserves = await TraderjoePair.getReserves();
        const traderjoeReserve0 = Number(ethers.utils.formatUnits(traderjoeReserves[0], 18));
        const traderjoeReserve1 = Number(ethers.utils.formatUnits(traderjoeReserves[1], 18));
        const traderjoePrice = traderjoeReserve0 / traderjoeReserve1;


        // - check if the difference can cover DEX fees ------------------------------------------------------->
        const tokenToBorrow = pangolinPrice > traderjoePrice ? this.token1 : this.token0;
        const tokenToBorrowSymbol = pangolinPrice > traderjoePrice ? this.token1Symbol : this.token0Symbol;
        const tokenToReturnSymbol = pangolinPrice > traderjoePrice ? this.token0Symbol : this.token1Symbol;
        let volumeToBorrow;
        let totalRepaymentInReturnToken;
        let totalReceivedTokensFromSwap;

        if (tokenToBorrow === this.token0) {
          volumeToBorrow = this.TOKEN0_TRADE;
          totalRepaymentInReturnToken = pangolinPrice * volumeToBorrow * (1 + (this.pangolinSwapRate / 100));
          totalReceivedTokensFromSwap = traderjoePrice * volumeToBorrow * (1 - (this.traderjoeSwapRate / 100));
        }
        else {
          volumeToBorrow = this.TOKEN1_TRADE;
          totalRepaymentInReturnToken = (volumeToBorrow / pangolinPrice) * (1 + (this.pangolinSwapRate / 100));
          totalReceivedTokensFromSwap = (volumeToBorrow / traderjoePrice) * (1 - (this.traderjoeSwapRate / 100));
        }
        const potentialProfitInReturnToken = totalReceivedTokensFromSwap - totalRepaymentInReturnToken;
        const potentialProfitInWavax = tokenToBorrow === this.token1 ? potentialProfitInReturnToken : (potentialProfitInReturnToken / traderjoePrice); // - assuming token0 is WAVAX
        const shouldConsiderTrade = totalReceivedTokensFromSwap > totalRepaymentInReturnToken;
        // -------------------------------------------------------------------------------------------------------

        
        // - tabulate the result to the console
        this.taste(traderjoePrice, pangolinPrice, potentialProfitInReturnToken, tokenToBorrowSymbol, volumeToBorrow, tokenToReturnSymbol);


        // - don't consider trading if spread cannot cover DEX fees
        if (!shouldConsiderTrade) return;


        /**
         * @async function to estimate gas to be used for transaction
         */
        // const gasLimit = await this.FlashSwapContract.estimateGas.flashSwap(
        //   pangolinPairAddress,
        //   tokenToBorrow,
        //   ethers.utils.parseEther(`${volumeToBorrow}`).toString()
        // );
        // const gasPrice = await this.wallet.getGasPrice();
        // const gasCost = Number(ethers.utils.formatEther(gasPrice.mul(gasLimit)));
        // const shouldActuallyTrade = potentialProfitInWavax > gasCost;
        // const options = { gasPrice, gasLimit };
        // ------------------------------------------------------------------------>


        // - don't trade if gasCost is higher than spread
        // if (!shouldActuallyTrade) return;


        /**
         * @async function to EXECUTE ARBITRAGE TRADE
         */
        const tx = await this.FlashSwapContract.flashSwap(
          pangolinPairAddress,
          tokenToBorrow,
          ethers.utils.parseEther(`${volumeToBorrow}`).toString()
          // options
        );
        await tx.wait();
        this.emit('tx-hash', { 'hash': tx.hash });
        // -------------------------------------------------------->
      }
      catch (err) {
        console.log(new Error(err.message));
      }
    });
  }


  /**
   * function for logging the price info of tokens from new blocks to the console
   * @param {Number} traderjoeRate - rate of the token pair from traderjoe_xyz DEX
   * @param {Number} pangolinRate - rate of the token pair from pangolin DEX
   * @param {Number} potentialProfit - profit after DEXes fees have been removed (does not take gas fee for transaction into account)
   * @param {String} borrowTokenSymbol - ticker symbol of the token that's to be borrowed from pangolin DEX
   * @param {Number} borrowVolume - amount of tokens to be borrowed
   * @param {String} returnTokenSymbol - ticker symbol of the token that's to be returned to pangolin DEX
   * @method taste
   */
  taste = (traderjoeRate, pangolinRate, potentialProfit, borrowTokenSymbol, borrowVolume, returnTokenSymbol) => {
    console.table([{
      'Token0': this.token0Symbol,
      'Token1': this.token1Symbol,
      'Trader Joe': traderjoeRate,
      'Pangolin': pangolinRate,
      'Borrow': `${borrowVolume.toLocaleString()} ${borrowTokenSymbol}`,
      'Potential Profit': `${potentialProfit.toLocaleString()} ${returnTokenSymbol}`
    }]);
  }


  /**
   * @async function for listening to events on the blockchain and raising those events on the server
   * @method serve
   */
  serve = async () => {

    this.FlashSwapContract.on('Trade', async (tokenAdress, profit) => {
      this.emit('trade', { 'token': tokenAdress, 'profit': profit });
    });

    this.FlashSwapContract.on('GasAdded', async (depositor, value) => {
      this.emit('gas-added', { 'by': depositor, 'amount': value });
    });

    this.FlashSwapContract.on('Withdraw', async (sender, amount) => {
      this.emit('withdrawal', { 'by': sender, 'amount': amount });
    });
    
  }


  /**
   * @async function to check the balance of flashswap contract
   * @method flourRemaining
   * @returns {Promise} resolves to the contract's balance
   */
  flourRemaining = async () => {
    return await this.FlashSwapContract.checkGas();
  }
  
}




module.exports = GingerBread;