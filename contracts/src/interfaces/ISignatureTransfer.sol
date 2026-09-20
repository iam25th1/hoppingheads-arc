// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title ISignatureTransfer
/// @notice The slice of Uniswap's Permit2 SignatureTransfer that ArenaEscrow uses. Permit2 is
///         predeployed on Arc at 0x000000000022D473030F116dDEE9F6B43aC78BA3.
interface ISignatureTransfer {
    struct TokenPermissions {
        address token;
        uint256 amount;
    }

    struct PermitTransferFrom {
        TokenPermissions permitted;
        uint256 nonce;
        uint256 deadline;
    }

    struct SignatureTransferDetails {
        address to;
        uint256 requestedAmount;
    }

    function permitTransferFrom(
        PermitTransferFrom memory permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes calldata signature
    ) external;

    function DOMAIN_SEPARATOR() external view returns (bytes32);
}
