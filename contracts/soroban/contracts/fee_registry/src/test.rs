#[cfg(test)]
mod test {
    use soroban_sdk::{testutils::Address as _, Address, Env};
    use crate::{FeeRegistry, FeeRegistryClient, ProposalStatus};

    fn setup_contract(env: &Env) -> (Address, FeeRegistryClient<'_>) {
        let contract_id = env.register_contract(None, FeeRegistry);
        let client = FeeRegistryClient::new(env, &contract_id);
        (contract_id, client)
    }

    #[test]
    fn test_initialize() {
        let env = Env::default();
        env.mock_all_auths();
        let (_contract_id, client) = setup_contract(&env);
        let admin = Address::generate(&env);
        let governance_token = Address::generate(&env);

        client.initialize(
            &admin,
            &governance_token,
            &250, // 2.5% platform fee
            &500, // 5% creator share
        );

        assert_eq!(client.get_fee(), 250);
        assert_eq!(client.get_creator_share(), 500);
        assert_eq!(client.get_admin(), admin);
        assert_eq!(client.get_governance_token(), governance_token);
    }

    #[test]
    #[should_panic]
    fn test_initialize_requires_admin_auth() {
        let env = Env::default();
        let (_contract_id, client) = setup_contract(&env);
        let admin = Address::generate(&env);
        let governance_token = Address::generate(&env);

        client.initialize(
            &admin,
            &governance_token,
            &250,
            &500,
        );
    }

    #[test]
    fn test_get_fee() {
        let env = Env::default();
        env.mock_all_auths();
        let (_contract_id, client) = setup_contract(&env);
        let admin = Address::generate(&env);
        let governance_token = Address::generate(&env);

        client.initialize(&admin, &governance_token, &300, &400);

        assert_eq!(client.get_fee(), 300);
    }

    #[test]
    #[should_panic(expected = "Already initialized")]
    fn test_double_initialize() {
        let env = Env::default();
        env.mock_all_auths();
        let (_contract_id, client) = setup_contract(&env);
        let admin = Address::generate(&env);
        let governance_token = Address::generate(&env);

        client.initialize(&admin, &governance_token, &250, &500);
        client.initialize(&admin, &governance_token, &300, &400);
    }

    #[test]
    fn test_admin_set_fee() {
        let env = Env::default();
        env.mock_all_auths();
        let (_contract_id, client) = setup_contract(&env);
        let admin = Address::generate(&env);
        let governance_token = Address::generate(&env);

        client.initialize(&admin, &governance_token, &250, &500);

        client.admin_set_fee(&admin, &350, &450);

        assert_eq!(client.get_fee(), 350);
        assert_eq!(client.get_creator_share(), 450);
    }

    #[test]
    #[should_panic(expected = "Only the admin can set the fee")]
    fn test_admin_set_fee_rejects_any_other_address() {
        let env = Env::default();
        env.mock_all_auths();
        let (_contract_id, client) = setup_contract(&env);
        let admin = Address::generate(&env);
        let governance_token = Address::generate(&env);
        client.initialize(&admin, &governance_token, &250, &500);

        // Signing for itself is not enough: the caller must be the stored admin.
        let attacker = Address::generate(&env);
        client.admin_set_fee(&attacker, &900, &900);
    }

    #[test]
    fn test_admin_set_fee_without_admin_auth_fails() {
        let env = Env::default();
        env.mock_all_auths();
        let (_contract_id, client) = setup_contract(&env);
        let admin = Address::generate(&env);
        let governance_token = Address::generate(&env);
        client.initialize(&admin, &governance_token, &250, &500);

        // set_auths(&[]) turns mocking back off, so nothing signs.
        env.set_auths(&[]);
        assert!(client.try_admin_set_fee(&admin, &350, &450).is_err());

        assert_eq!(client.get_fee(), 250);
        assert_eq!(client.get_creator_share(), 500);
    }

    #[test]
    #[should_panic(expected = "Platform fee BPS must not exceed MAX_FEE_BPS")]
    fn test_admin_set_fee_rejects_fee_above_cap() {
        let env = Env::default();
        env.mock_all_auths();
        let (_contract_id, client) = setup_contract(&env);
        let admin = Address::generate(&env);
        let governance_token = Address::generate(&env);
        client.initialize(&admin, &governance_token, &250, &500);

        client.admin_set_fee(&admin, &1001, &500);
    }

    #[test]
    #[should_panic(expected = "Creator share BPS must not exceed MAX_CREATOR_SHARE_BPS")]
    fn test_admin_set_fee_rejects_creator_share_above_cap() {
        let env = Env::default();
        env.mock_all_auths();
        let (_contract_id, client) = setup_contract(&env);
        let admin = Address::generate(&env);
        let governance_token = Address::generate(&env);
        client.initialize(&admin, &governance_token, &250, &500);

        client.admin_set_fee(&admin, &250, &10001);
    }

    #[test]
    #[should_panic(expected = "Platform fee BPS must not exceed MAX_FEE_BPS")]
    fn test_initialize_rejects_fee_above_cap() {
        let env = Env::default();
        env.mock_all_auths();
        let (_contract_id, client) = setup_contract(&env);
        let admin = Address::generate(&env);
        let governance_token = Address::generate(&env);

        client.initialize(&admin, &governance_token, &1001, &500);
    }

    #[test]
    fn test_vote_locks_deposit_and_prevents_transfer_double_voting() {
        use soroban_sdk::{testutils::Ledger, token};

        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, client) = setup_contract(&env);
        let admin = Address::generate(&env);

        let token_admin = Address::generate(&env);
        let token_addr = env.register_stellar_asset_contract(token_admin.clone());
        let token_admin_client = token::StellarAssetClient::new(&env, &token_addr);
        let token_client = token::Client::new(&env, &token_addr);

        client.initialize(&admin, &token_addr, &250, &500);

        let proposer = Address::generate(&env);
        let voter_a = Address::generate(&env);
        let voter_b = Address::generate(&env);

        token_admin_client.mint(&proposer, &2000);
        token_admin_client.mint(&voter_a, &1000);

        // Propose change
        let proposal_id = client.propose_change(&proposer, &300, &600);
        assert_eq!(proposal_id, 1);

        // Voter A votes in favor
        client.vote(&voter_a, &proposal_id, &true);

        // Voter A's tokens are now locked in FeeRegistry contract
        assert_eq!(token_client.balance(&voter_a), 0);
        assert_eq!(token_client.balance(&contract_id), 1000);
        assert_eq!(client.get_locked_deposit(&proposal_id, &voter_a), 1000);

        let proposal = client.get_pending_proposal().unwrap();
        assert_eq!(proposal.votes_for, 1000);
        assert_eq!(proposal.votes_against, 0);

        // Voter A tries to transfer to Voter B: fails because balance is 0
        let transfer_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            token_client.transfer(&voter_a, &voter_b, &1000);
        }));
        assert!(transfer_result.is_err());

        // Voter B cannot vote with Voter A's tokens (balance is 0)
        assert_eq!(token_client.balance(&voter_b), 0);
        let vote_b_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.vote(&voter_b, &proposal_id, &true);
        }));
        assert!(vote_b_result.is_err());

        // Vote weight remains 1000 - transferring after voting didn't add weight
        let proposal_after = client.get_pending_proposal().unwrap();
        assert_eq!(proposal_after.votes_for, 1000);

        // Reclaiming before deadline panics
        let reclaim_early = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.reclaim_vote_deposit(&voter_a, &proposal_id);
        }));
        assert!(reclaim_early.is_err());

        // Fast forward ledger time past deadline (7 days)
        env.ledger().set_timestamp(env.ledger().timestamp() + 7 * 24 * 60 * 60 + 1);

        // Execute proposal
        client.execute_proposal(&proposal_id);
        let final_proposal = client.get_pending_proposal().unwrap();
        assert_eq!(final_proposal.status, ProposalStatus::Executed);
        assert_eq!(client.get_fee(), 300);
        assert_eq!(client.get_creator_share(), 600);

        // Voter A reclaims deposit after voting ends
        client.reclaim_vote_deposit(&voter_a, &proposal_id);
        assert_eq!(token_client.balance(&voter_a), 1000);
        assert_eq!(client.get_locked_deposit(&proposal_id, &voter_a), 0);
    }

    #[test]
    #[should_panic(expected = "Already voted on this proposal")]
    fn test_double_voting_panics() {
        use soroban_sdk::token;

        let env = Env::default();
        env.mock_all_auths();
        let (_contract_id, client) = setup_contract(&env);
        let admin = Address::generate(&env);

        let token_admin = Address::generate(&env);
        let token_addr = env.register_stellar_asset_contract(token_admin.clone());
        let token_admin_client = token::StellarAssetClient::new(&env, &token_addr);

        client.initialize(&admin, &token_addr, &250, &500);

        let proposer = Address::generate(&env);
        let voter = Address::generate(&env);

        token_admin_client.mint(&proposer, &2000);
        token_admin_client.mint(&voter, &1000);

        let proposal_id = client.propose_change(&proposer, &300, &600);
        client.vote(&voter, &proposal_id, &true);
        // Second vote panics
        client.vote(&voter, &proposal_id, &true);
    }

    #[test]
    #[should_panic(expected = "No deposit to reclaim")]
    fn test_reclaim_with_no_deposit_panics() {
        use soroban_sdk::{testutils::Ledger, token};

        let env = Env::default();
        env.mock_all_auths();
        let (_contract_id, client) = setup_contract(&env);
        let admin = Address::generate(&env);

        let token_admin = Address::generate(&env);
        let token_addr = env.register_stellar_asset_contract(token_admin.clone());
        let token_admin_client = token::StellarAssetClient::new(&env, &token_addr);

        client.initialize(&admin, &token_addr, &250, &500);

        let proposer = Address::generate(&env);
        let non_voter = Address::generate(&env);

        token_admin_client.mint(&proposer, &2000);
        let proposal_id = client.propose_change(&proposer, &300, &600);

        env.ledger().set_timestamp(env.ledger().timestamp() + 7 * 24 * 60 * 60 + 1);
        client.execute_proposal(&proposal_id);

        client.reclaim_vote_deposit(&non_voter, &proposal_id);
    }

    #[test]
    fn test_vote_deposit_survives_past_default_ttl() {
        use soroban_sdk::testutils::storage::{Instance as _, Persistent as _};
        use soroban_sdk::testutils::Ledger;
        use soroban_sdk::token;
        use crate::{DataKey, STORAGE_TTL_LEDGERS};

        let env = Env::default();
        env.mock_all_auths();
        let (contract_id, client) = setup_contract(&env);
        let admin = Address::generate(&env);
        let token_addr = env.register_stellar_asset_contract(Address::generate(&env));
        let token_admin_client = token::StellarAssetClient::new(&env, &token_addr);
        let token_client = token::Client::new(&env, &token_addr);
        client.initialize(&admin, &token_addr, &250, &500);

        let proposer = Address::generate(&env);
        let voter = Address::generate(&env);
        token_admin_client.mint(&proposer, &2000);
        token_admin_client.mint(&voter, &1000);
        let proposal_id = client.propose_change(&proposer, &300, &600);
        client.vote(&voter, &proposal_id, &true);

        env.as_contract(&contract_id, || {
            let deposit_key = DataKey::LockedDeposit(proposal_id, voter.clone());
            assert!(env.storage().persistent().get_ttl(&deposit_key) >= STORAGE_TTL_LEDGERS - 1);
            assert!(env.storage().persistent().get_ttl(&DataKey::Proposal(proposal_id)) >= STORAGE_TTL_LEDGERS - 1);
            assert!(env.storage().instance().get_ttl() >= STORAGE_TTL_LEDGERS - 1);
        });

        // Keep the test token alive; only the registry's own storage is under test.
        let jump = env.ledger().get().min_persistent_entry_ttl * 100;
        env.as_contract(&token_addr, || {
            env.storage().instance().extend_ttl(jump + 1000, jump + 1000);
        });
        env.ledger().with_mut(|li| {
            li.sequence_number += jump;
            li.timestamp += 7 * 24 * 60 * 60 + 1;
        });

        client.execute_proposal(&proposal_id);
        client.reclaim_vote_deposit(&voter, &proposal_id);
        assert_eq!(token_client.balance(&voter), 1000);
    }
}
