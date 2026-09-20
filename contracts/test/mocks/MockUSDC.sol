// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Arc's USDC through its ERC-20 view: 6 decimals, and transfers to or from a
///         blocklisted address revert. Enough of the predeploy for the unit tests; the fork
///         tests use the real one.
contract MockUSDC is ERC20 {
    mapping(address => bool) public blocklisted;

    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlocklisted(address account, bool blocked) external {
        blocklisted[account] = blocked;
    }

    function _update(address from, address to, uint256 value) internal override {
        require(!blocklisted[from] && !blocklisted[to], "USDC: blocklisted");
        super._update(from, to, value);
    }
}
