#include <box2d/box2d.h>
#include <cmath>
#include <limits>
#include "fcv1_simulator_core.hpp"
#include <algorithm>

inline std::pair<b2Vec2, float> normalize(b2Vec2 const &v)
{
    b2Vec2 normalized = v;
    float length = normalized.Normalize();
    return {normalized, length};
}

inline float longitudinal_acceleration(float speed)
{
    constexpr float kGravity = 9.80665f;
    return -(0.00200985f / (speed + 0.06385782f) + 0.00626286f) * kGravity;
}

inline float yaw_rate(float speed, float angularVelocity)
{
    if (std::abs(angularVelocity) <= EPSILON)
    {
        return 0.f;
    }
    return (angularVelocity > 0.f ? 1.0f : -1.0f) * 0.00820f * std::pow(speed, -0.8f);
}

inline float angular_acceleration(float linearSpeed)
{
    float clampedSpeed = std::max(linearSpeed, 0.001f);
    return -0.025f / clampedSpeed;
}

void SimulatorFCV1::ContactListener::PostSolve(b2Contact *contact, const b2ContactImpulse *impulse)
{
    b2Body *a_body = contact->GetFixtureA()->GetBody();
    b2Body *b_body = contact->GetFixtureB()->GetBody();

    digitalcurling3::Collision collision;
    collision.a.id = static_cast<int>(a_body->GetUserData().pointer);
    collision.b.id = static_cast<int>(b_body->GetUserData().pointer);

    add_unique_id(instance_->is_awake, collision.a.id);
    add_unique_id(instance_->is_awake, collision.b.id);

    add_unique_id(instance_->moved, collision.a.id);
    add_unique_id(instance_->moved, collision.b.id);

    b2WorldManifold world_manifold;
    contact->GetWorldManifold(&world_manifold);

    collision.normal_impulse = impulse->normalImpulses[0];
    collision.tangent_impulse = impulse->tangentImpulses[0];
}

void SimulatorFCV1::ContactListener::add_unique_id(std::vector<int> &list, int id)
{
    if (std::find(list.begin(), list.end(), id) == list.end())
    {
        list.push_back(id);
    }
}

SimulatorFCV1::SimulatorFCV1(std::vector<digitalcurling3::StoneData> const &stones)
    : contact_listener_(this),
      stones(stones),
      world(b2Vec2(0, 0))
{
    stone_body_def.type = b2_dynamicBody;
    stone_body_def.awake = false;
    stone_body_def.bullet = true;
    stone_body_def.enabled = false;

    b2CircleShape stone_shape;
    stone_shape.m_radius = kStoneRadius;

    b2FixtureDef stone_fixture_def;
    stone_fixture_def.shape = &stone_shape;
    stone_fixture_def.friction = 0.2f;
    stone_fixture_def.restitution = 1.0;
    stone_fixture_def.restitutionThreshold = 0.f;
    stone_fixture_def.density = kStoneMass / (b2_pi * kStoneRadius * kStoneRadius);

    for (size_t i = 0; i < kStoneMax; ++i)
    {
        stone_body_def.userData.pointer = static_cast<uintptr_t>(i);
        stone_bodies[i] = world.CreateBody(&stone_body_def);
        stone_bodies[i]->CreateFixture(&stone_fixture_def);
    }
    world.SetContactListener(&contact_listener_);
}

void SimulatorFCV1::change_shot(int total_shot)
{
    this->total_shot = total_shot;
}

bool SimulatorFCV1::is_freeguardzone(b2Body *body)
{
    float dx = body->GetPosition().x;
    float dy = body->GetPosition().y - tee_line;
    float distance_squared = dx * dx + dy * dy;
    if (dy < 0 && distance_squared > house_touch_radius * house_touch_radius)
    {
        return true;
    }
    return false;
}

bool SimulatorFCV1::is_removed_from_play(int stone_id) const
{
    const b2Body *body = stone_bodies[stone_id];
    const b2Vec2 position = body->GetPosition();
    const bool delivered_stone_contacted =
        std::any_of(moved.begin(), moved.end(), [this](int moved_id)
        {
            return moved_id != delivered_stone_id;
        });
    const bool outside_sheet =
        position.x >= stone_x_upper_limit ||
        position.x <= stone_x_lower_limit ||
        position.y > stone_y_upper_limit;
    const bool hogged_stone =
        stone_id == delivered_stone_id &&
        !delivered_stone_contacted &&
        position.y <= stone_y_lower_limit;

    return !body->IsEnabled() ||
           (position.x == 0.0f && position.y == 0.0f) ||
           outside_sheet ||
           hogged_stone;
}

void SimulatorFCV1::restore_pre_shot_state()
{
    for (size_t i = 0; i < kStoneMax; ++i)
    {
        const digitalcurling3::StoneData &stone = stones[i];
        stone_bodies[i]->SetTransform(b2Vec2(stone.position.x, stone.position.y), 0.f);
        stone_bodies[i]->SetLinearVelocity(b2Vec2_zero);
        stone_bodies[i]->SetAngularVelocity(0.f);

        const bool in_play = stone.position.x != 0.f || stone.position.y != 0.f;
        stone_bodies[i]->SetEnabled(in_play);
        stone_bodies[i]->SetAwake(in_play);
    }
}

void SimulatorFCV1::freeguardzone_checker()
{
    in_free_guard_zone.clear();
    for (size_t i = 0; i < kStoneMax; ++i)
    {
        b2Body *body = stone_bodies[i];
        const b2Vec2 position = body->GetPosition();
        const bool opponent_stone =
            static_cast<unsigned int>(i / stones_per_team) != delivering_team_id;
        const bool outside_sheet =
            position.x >= stone_x_upper_limit ||
            position.x <= stone_x_lower_limit ||
            position.y > stone_y_upper_limit;
        if (body->IsEnabled() &&
            opponent_stone &&
            !outside_sheet &&
            is_freeguardzone(body))
        {
            in_free_guard_zone.push_back(static_cast<int>(i));
        }
    }
}

void SimulatorFCV1::is_in_playarea()
{
    for (int i : in_free_guard_zone)
    {
        if (is_removed_from_play(i))
        {
            restore_pre_shot_state();
            break;
        }
    }
}

bool SimulatorFCV1::on_center_line(b2Body *body)
{
    if (std::abs(body->GetPosition().x) <= kStoneRadius)
    {
        return true;
    }
    return false;
}

void SimulatorFCV1::no_tick_checker()
{
    is_no_tick.clear();
    for (size_t i = 0; i < kStoneMax; ++i)
    {
        b2Body *body = stone_bodies[i];
        const b2Vec2 position = body->GetPosition();
        const bool opponent_stone =
            static_cast<unsigned int>(i / stones_per_team) != delivering_team_id;
        const bool outside_sheet =
            position.x >= stone_x_upper_limit ||
            position.x <= stone_x_lower_limit ||
            position.y > stone_y_upper_limit;
        if (body->IsEnabled() &&
            opponent_stone &&
            !outside_sheet &&
            is_freeguardzone(body) &&
            on_center_line(body))
        {
            is_no_tick.push_back(static_cast<int>(i));
        }
    }
}

void SimulatorFCV1::no_tick_rule()
{
    for (int i : is_no_tick)
    {
        b2Body *body = stone_bodies[i];
        float position_x = body->GetPosition().x;
        if (std::abs(position_x) > kStoneRadius ||
            is_removed_from_play(i))
        {
            restore_pre_shot_state();
            break;
        }
    }
}

void SimulatorFCV1::modified_fgz_checker()
{
    protected_stones_modified_fgz.clear();
    for (size_t i = 0; i < kStoneMax; ++i)
    {
        b2Body *body = stone_bodies[i];
        const b2Vec2 position = body->GetPosition();
        if (!body->IsEnabled() ||
            (position.x == 0.0f && position.y == 0.0f) ||
            position.x >= stone_x_upper_limit ||
            position.x <= stone_x_lower_limit ||
            position.y > stone_y_upper_limit)
        {
            continue;
        }
        protected_stones_modified_fgz.push_back(static_cast<int>(i));
    }
}

void SimulatorFCV1::modified_fgz_rule()
{
    bool violation = false;
    for (int id : protected_stones_modified_fgz)
    {
        if (is_removed_from_play(id))
        {
            violation = true;
            break;
        }
    }

    if (!violation)
    {
        return;
    }

    restore_pre_shot_state();
}

std::vector<std::vector<StonePosition>> SimulatorFCV1::step(float seconds_per_frame)
{
    trajectory_list.clear();
    while (!is_awake.empty())
    {
        trajectory.clear();
        const std::vector<int> active_stones = is_awake;
        for (int index : active_stones)
        {
            b2Vec2 const stone_velocity = stone_bodies[index]->GetLinearVelocity();
            auto const [normalized_stone_velocity, stone_speed] = normalize(stone_velocity);
            float const angular_velocity = stone_bodies[index]->GetAngularVelocity();

            if (stone_speed > EPSILON)
            {
                digitalcurling3::Vector2 stone_position = {stone_bodies[index]->GetPosition().x, stone_bodies[index]->GetPosition().y};
                StonePosition pos = {index, stone_position.x, stone_position.y};
                trajectory.push_back(pos);

                if (stone_position.x >= stone_x_upper_limit || stone_position.x <= stone_x_lower_limit)
                {
                    stone_bodies[index]->SetTransform(b2Vec2(0.f, 0.f), 0.f);
                    stone_bodies[index]->SetAwake(false);
                    stone_bodies[index]->SetEnabled(false);
                    is_awake.erase(std::remove(is_awake.begin(), is_awake.end(), index), is_awake.end());
                    continue;
                }
                float const new_stone_speed = stone_speed + longitudinal_acceleration(stone_speed) * seconds_per_frame;
                if (new_stone_speed <= 0.f)
                {
                    stone_bodies[index]->SetLinearVelocity(b2Vec2_zero);
                }
                else
                {
                    float const yaw = yaw_rate(stone_speed, angular_velocity) * seconds_per_frame;
                    float const longitudinal_velocity = new_stone_speed * std::cos(yaw);
                    float const transverse_velocity = new_stone_speed * std::sin(yaw);
                    b2Vec2 const &e_longitudinal = normalized_stone_velocity;
                    b2Vec2 const e_transverse = e_longitudinal.Skew();
                    b2Vec2 const new_stone_velocity = longitudinal_velocity * e_longitudinal + transverse_velocity * e_transverse;
                    stone_bodies[index]->SetLinearVelocity(new_stone_velocity);
                }
            }else{
                stone_bodies[index]->SetLinearVelocity(b2Vec2_zero);
            }

            if (std::abs(angular_velocity) > EPSILON)
            {
                float const angular_accel = angular_acceleration(stone_speed) * seconds_per_frame;
                float new_angular_velocity = 0.f;
                if (std::abs(angular_velocity) <= std::abs(angular_accel))
                {
                    new_angular_velocity = 0.f;
                }
                else
                {
                    new_angular_velocity = angular_velocity + angular_accel * angular_velocity / std::abs(angular_velocity);
                }
                stone_bodies[index]->SetAngularVelocity(new_angular_velocity);
            }

            if (stone_bodies[index]->GetLinearVelocity().Length() <= EPSILON &&
                std::abs(stone_bodies[index]->GetAngularVelocity()) <= EPSILON)
            {
                is_awake.erase(std::remove(is_awake.begin(), is_awake.end(), index), is_awake.end());
            }
        }
        trajectory_list.push_back(trajectory);

        world.Step(
            seconds_per_frame,
            8,
            3);
    }
    return trajectory_list;
}

void SimulatorFCV1::set_stones()
{
    for (size_t i = 0; i < kStoneMax; ++i)
    {
        const digitalcurling3::StoneData &stone = stones[i];
        digitalcurling3::Vector2 position = stone.position;
        if (position.x == 0.f && position.y == 0.f)
        {
            stone_bodies[i]->SetEnabled(false);
        }
        else
        {
            stone_bodies[i]->SetEnabled(true);
            stone_bodies[i]->SetAwake(true);
            stone_bodies[i]->SetTransform(b2Vec2(position.x, position.y), 0.f);
        }
    }
}

void SimulatorFCV1::set_velocity(float velocity_x, float velocity_y, float angular_velocity, unsigned int shot_per_team, unsigned int team_id, unsigned int applied_rule)
{
    this->applied_rule = applied_rule;
    this->shot_per_team = shot_per_team;
    this->delivering_team_id = team_id;
    int index = static_cast<int>(this->shot_per_team) + static_cast<int>(team_id) * 8;
    this->delivered_stone_id = index;

    stone_bodies[index]->SetLinearVelocity(b2Vec2(velocity_x, velocity_y));
    stone_bodies[index]->SetAngularVelocity(angular_velocity);
    stone_bodies[index]->SetEnabled(true);
    stone_bodies[index]->SetAwake(true);
    stone_bodies[index]->SetTransform(b2Vec2(0.0f, 0.0f), 0.f);
    is_awake.push_back(index);
    moved.push_back(index);

    if (this->total_shot < 5)
    {
        if (applied_rule == 0)
        {
            freeguardzone_checker();
        }
        else if (applied_rule == 1)
        {
            freeguardzone_checker();
            no_tick_checker();
        }
    }
    if (applied_rule == 2)
    {
        if (this->total_shot < 3)
        {
            modified_fgz_checker();
        }
    }
}

digitalcurling3::StoneDataVector SimulatorFCV1::get_stones()
{
    if (this->total_shot < 5)
    {
        if (this->applied_rule == 0)
        {
            is_in_playarea();
        }
        else if (this->applied_rule == 1)
        {
            is_in_playarea();
            no_tick_rule();
        }
    }

    if (this->applied_rule == 2 && this->total_shot < 3)
    {
        modified_fgz_rule();
    }

    digitalcurling3::StoneDataVector stones_data;
    for (size_t i = 0; i < kStoneMax; ++i)
    {
        b2Body *body = stone_bodies[i];
        b2Vec2 position = body->GetPosition();
        if (is_removed_from_play(static_cast<int>(i)))
        {
            body->SetTransform(b2Vec2(0.f, 0.f), 0.f);
            body->SetEnabled(false);
            body->SetAwake(false);
        }
        b2Vec2 after_position = body->GetPosition();
        stones_data.stones.push_back({digitalcurling3::Vector2(after_position.x, after_position.y)});
    }
    return stones_data;
}
